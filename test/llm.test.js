import test from "node:test";
import assert from "node:assert/strict";
import { ContextOverflowError, LlmRunner, estimateTokens } from "../src/llm/runner.js";
import { PromptStore } from "../src/llm/prompt-store.js";
import { buildChatRequest, parseJsonResponse, repairJson } from "../src/llm/openai-client.js";
import { renderInput } from "../src/llm/input-renderer.js";
import { planContext } from "../src/llm/context-plan.js";
import { defaultConfig } from "../src/domain/config.js";
import { ROLES } from "../src/domain/constants.js";

function aiPlayer(overrides = {}, role = "villager") {
  return {
    id: "P1", role, controller: "ai",
    llm: { baseUrl: "http://localhost:11434/v1", model: "qwen3:8b", retries: 0, maxTokens: 1600, contextTokens: 16384, ...overrides },
  };
}

const reply = (content, extra = {}) => ({ content, rawEnvelope: {}, usage: null, finishReason: "stop", latencyMs: 1, ...extra });

function sampleInput(overrides = {}) {
  return {
    publicState: {
      day: 1, phase: "vote", round: null, roleCounts: { werewolf: 1, madman: 0, seer: 1, bodyguard: 1, villager: 1 },
      players: [{ id: "P1", alive: true, co: null }, { id: "P2", alive: true, co: "seer" }],
      record: [{ type: "speech", day: 1, round: 1, playerId: "P2", speech: "P1が怪しい。", claims: [] }],
      deaths: [],
    },
    self: { id: "P1", role: "villager", privateInfo: { divinations: [], guards: [], wolfPartners: [], votes: [], attackVotes: [] }, wolfStrategyMemory: "" },
    task: { validTargets: ["P1", "P2"] },
    ...overrides,
  };
}

test("LLM calls carry the output rules, the role vocabulary and a call-specific JSON schema", async () => {
  const captured = {};
  const client = {
    async chat(config, messages, options) {
      Object.assign(captured, { config, messages, options });
      return reply('{"private_thought":"様子を見る","type":"none","claimed_role":null}');
    },
  };
  const runner = new LlmRunner({ client, promptStore: new PromptStore() });
  const result = await runner.run({
    gameId: "test", player: aiPlayer(), callType: "co", day: 1, phase: "initial_co", round: null, language: "ja",
    input: sampleInput({ task: {} }), validate: (value) => value, fallback: () => ({ type: "none", claimed_role: null }),
  });
  assert.equal(result.value.type, "none");
  assert.match(captured.messages[0].content, /自然言語の値はすべて日本語/);
  assert.match(captured.messages[0].content, /人狼=werewolf/);
  assert.match(captured.messages[0].content, /Coming Out/);
  // 推論を封じる /no_think は付けない。思考は private_thought へ逃がす。
  assert.equal(captured.messages.some((m) => /no_think/.test(m.content)), false);
  assert.equal(captured.messages.length, 2);
  assert.deepEqual(captured.options.responseSchema.schema.required, ["private_thought", "type", "claimed_role"]);
  assert.equal(captured.options.responseSchema.strict, true);
  // 呼び出し種別ごとに出力予算を分け、さらに思考枠を上積みする。
  assert.equal(captured.options.maxTokens, 320 + 4096);
});

test("the private_thought rule appears only for calls that actually have that field", () => {
  const store = new PromptStore();
  assert.match(store.bundle("co", ROLES.VILLAGER).system, /private_thought フィールド/);
  assert.match(store.bundle("discussion", ROLES.VILLAGER, "en").system, /private_thought field/);
  for (const callType of ["vote", "wolf_meeting", "strategy_memory"]) {
    assert.doesNotMatch(store.bundle(callType, ROLES.WEREWOLF).system.split("\n\n")[0], /private_thought/, callType);
  }
});

test("every player is told what every role can do, in both languages, and each action gets its own output key", () => {
  const store = new PromptStore();
  const wolfRules = store.bundle("attack", ROLES.WEREWOLF).system;
  assert.match(wolfRules, /護衛した相手がその夜に襲撃された場合、襲撃は失敗し/);
  assert.match(wolfRules, /狂人は「人狼ではない」と判定されます/);
  assert.match(store.bundle("attack", ROLES.WEREWOLF, "en").system, /If the protected player is attacked that night, the attack fails/);
  assert.match(store.bundle("vote", ROLES.VILLAGER, "en").system, /Write every natural-language value in English/);
  const keys = { vote: "execute_target", attack: "attack_target", divination: "divine_target", guard: "guard_target" };
  for (const language of ["ja", "en"]) {
    for (const [callType, key] of Object.entries(keys)) {
      const role = { vote: ROLES.VILLAGER, attack: ROLES.WEREWOLF, divination: ROLES.SEER, guard: ROLES.BODYGUARD }[callType];
      const system = store.bundle(callType, role, language).system;
      assert.match(system, new RegExp(`"${key}"`), `${language} ${callType} must ask for ${key}`);
      // 例示値は <> で囲む。具体的な値の例はそのまま写されて返ってきた。
      assert.doesNotMatch(system, /"reason":"[^<]/, `${language} ${callType} example must be a placeholder`);
    }
  }
  assert.doesNotMatch(store.bundle("guard", ROLES.BODYGUARD).system, /処刑したい相手/);
});

test("the log keeps exactly what was sent on every attempt, including the repair request and output constraints", async () => {
  const sent = [];
  const client = {
    async chat(config, messages, options) {
      sent.push({ messages: structuredClone(messages), request: buildChatRequest(config, messages, options) });
      return sent.length === 1 ? reply('{"execute_target":"P9","reason":"候補外"}') : reply('{"execute_target":"P2","reason":"沈黙が気になる"}');
    },
  };
  const logs = [];
  const runner = new LlmRunner({ client, promptStore: new PromptStore(), onLog: (log) => logs.push(log) });
  const result = await runner.run({
    gameId: "test", player: aiPlayer({ retries: 1 }), callType: "vote", day: 1, phase: "vote", round: null, language: "ja",
    input: sampleInput(),
    validate: (value) => {
      if (value.execute_target !== "P2") throw new Error("execute_target が候補に含まれていません: P9。選べるのは P1, P2 のいずれかです");
      return { target: value.execute_target };
    },
    fallback: () => ({ target: "P2" }),
  });
  assert.equal(result.value.target, "P2");
  assert.equal(logs.length, 2);
  for (const [i, log] of logs.entries()) {
    // GUIが描くのはこの messages。LLMが実際に読んだものと一字一句同じでなければならない。
    assert.deepEqual(log.request.body.messages, sent[i].messages);
    assert.deepEqual(log.request, { ...sent[i].request, url: log.request.url });
    assert.equal(log.request.api, "ollama");
    assert.equal(log.request.body.format.required[0], "execute_target");
    assert.equal(log.request.body.options.num_ctx, 16384);
    assert.equal(Object.hasOwn(log, "inputPrompt"), false);
  }
  assert.equal(logs[1].request.body.messages.length, 3);
  assert.match(logs[1].request.body.messages[2].content, /却下理由: execute_target が候補に含まれていません/);
  assert.match(logs[1].request.body.messages[2].content, /P9/);
  assert.deepEqual(logs[1].acceptedValue, { target: "P2" });
});

test("OpenAI-compatible servers get response_format, Ollama gets its native API so num_ctx is honoured", () => {
  const schema = { name: "vote_response", strict: true, schema: { type: "object" } };
  const messages = [{ role: "user", content: "x" }];
  const openai = buildChatRequest({ baseUrl: "https://api.example.com/v1", model: "m", seed: 1, contextTokens: 8192 }, messages, { responseSchema: schema, maxTokens: 50 });
  assert.equal(openai.url, "https://api.example.com/v1/chat/completions");
  assert.deepEqual(openai.body.response_format, { type: "json_schema", json_schema: schema });
  assert.equal(openai.body.max_tokens, 50);
  const ollama = buildChatRequest({ baseUrl: "http://localhost:11434/v1", model: "m", seed: 1, temperature: 0.2, contextTokens: 8192 }, messages, { responseSchema: schema, maxTokens: 50 });
  assert.equal(ollama.url, "http://localhost:11434/api/chat");
  assert.deepEqual(ollama.body.format, { type: "object" });
  assert.deepEqual(ollama.body.options, { temperature: 0.2, num_predict: 50, num_ctx: 8192, seed: 1 });
  assert.equal(buildChatRequest({ baseUrl: "http://localhost:11434/v1", api: "openai", model: "m" }, messages).api, "openai");
});

test("the input is readable prose that states who you are, who is alive, what was said and what you may choose", () => {
  const prose = renderInput({ ...sampleInput(), task: { ...sampleInput().task, callType: "vote" } }, "en");
  assert.match(prose, /You are P1\. Your true role is villager\./);
  assert.match(prose, /- P2 \| alive \| current CO: seer/);
  assert.match(prose, /- P2: "P1が怪しい。"/);
  assert.match(prose, /## Players you can choose\nP1, P2/);
  assert.doesNotMatch(prose, /[{}]|"validTargets"/);
  const japanese = renderInput({ ...sampleInput(), task: { ...sampleInput().task, callType: "vote" } }, "ja");
  assert.match(japanese, /## 今回選べる相手\nP1, P2/);
});

test("a call that spent its whole budget on thinking is retried with a wider allowance and no instruction to think less", async () => {
  const budgets = [];
  const sent = [];
  const client = {
    async chat(_config, messages, options) {
      budgets.push(options.maxTokens);
      sent.push(messages);
      // 思考するモデルはcontentが空、思考だけが別フィールドで返る。max_tokensを使い切った状態。
      return budgets.length === 1
        ? reply("", { reasoning: "どう動くか考えている……", finishReason: "length" })
        : reply('{"message":"P3を噛む"}');
    },
  };
  const logs = [];
  const runner = new LlmRunner({ client, promptStore: new PromptStore(), onLog: (log) => logs.push(log) });
  const result = await runner.run({
    gameId: "test", player: aiPlayer({ retries: 1, reasoningTokens: 600 }, "werewolf"), callType: "wolf_meeting",
    day: 1, phase: "night", round: null, input: sampleInput({ task: { meeting: { purpose: "night", messages: [] } } }),
    validate: (value) => value, fallback: () => ({ message: "fallback" }),
  });
  assert.equal(result.value.message, "P3を噛む");
  assert.equal(budgets[0], 400 + 600);
  assert.equal(budgets[1], 400 + 1200);
  assert.match(logs[0].error, /出力が空/);
  assert.equal(logs[0].diagnostics.emptyContent, true);
  assert.equal(logs[0].diagnostics.outputTruncated, true);
  // 思考内容は研究用に残す（失敗した試行のほうが観察価値が高い）。ゲーム内には流さない。
  assert.equal(logs[0].reasoning, "どう動くか考えている……");
  // 枠切れは予算の問題。ここで思考を減らすよう促すと、推論を伴わない定型出力が本番に残る。
  assert.equal(sent[1].length, 2, "枠切れのリトライに指摘を足してはいけない");
  assert.equal(sent.flat().some((m) => /考える量を減ら|思考を減ら|先にJSON/.test(m.content)), false);
});

test("a rejected-but-present output is retried with its own text so the content survives the fix", async () => {
  const sent = [];
  const client = {
    async chat(_config, messages) {
      sent.push(messages);
      return sent.length === 1
        ? reply('{"private_thought":"x","speech":"P7は4人から疑われているので投票します。","claims":[]}')
        : reply('{"private_thought":"x","speech":"P7 has been accused by four players, so I will vote P7.","claims":[]}');
    },
  };
  const runner = new LlmRunner({ client, promptStore: new PromptStore(), onLog: () => {} });
  const result = await runner.run({
    gameId: "test", player: aiPlayer({ retries: 1 }), callType: "discussion", day: 1, phase: "discussion", round: 1, language: "en",
    input: sampleInput({ task: {} }),
    validate: (value) => {
      if (/[ぁ-ん]/u.test(value.speech)) throw new Error("The public speech is not in English. Keep the content and reasoning of speech unchanged and translate it into English as is");
      return value;
    },
    fallback: () => ({ speech: "fallback", claims: [] }),
  });
  assert.match(result.value.speech, /accused by four players/);
  // 却下時は前回の本文を返して直させる。作り直させると論拠が落ちた一行に縮む。
  assert.match(sent[1][2].content, /4人から疑われている/);
  assert.match(sent[1][2].content, /Do not change the substance of your decision/);
});

test("an input that does not fit the context is never sent and never trimmed; the call stops instead", async () => {
  let called = false;
  const client = { async chat() { called = true; return reply('{"message":"了解"}'); } };
  const statuses = [];
  const runner = new LlmRunner({ client, promptStore: new PromptStore(), onStatus: (s) => statuses.push(s) });
  const bulky = sampleInput();
  bulky.publicState.record = Array.from({ length: 400 }, (_, i) => ({ type: "speech", day: 1 + (i % 5), round: 1, playerId: "P1", speech: "あ".repeat(300), claims: [] }));
  await assert.rejects(() => runner.run({
    gameId: "test", player: aiPlayer({ contextTokens: 8192 }, "werewolf"), callType: "wolf_meeting", day: 5, phase: "night_wolf_meeting", round: null,
    input: bulky, validate: (value) => value, fallback: () => ({ message: "" }),
  }), ContextOverflowError);
  assert.equal(called, false, "溢れる入力を送っている");
  assert.equal(statuses.at(-1).status, "context_overflow");
});

test("an input close to the limit is sent in full and flagged", async () => {
  const client = { async chat() { return reply('{"message":"了解"}'); } };
  const runner = new LlmRunner({ client, promptStore: new PromptStore() });
  const input = sampleInput();
  input.publicState.record = Array.from({ length: 12 }, () => ({ type: "speech", day: 1, round: 1, playerId: "P2", speech: "あ".repeat(250), claims: [] }));
  const result = await runner.run({
    gameId: "test", player: aiPlayer({ contextTokens: 10000 }, "werewolf"), callType: "wolf_meeting", day: 1, phase: "x", round: null,
    input, validate: (value) => value, fallback: () => ({ message: "" }),
  });
  assert.equal(result.log.diagnostics.contextNearLimit, true);
  assert.equal(result.log.request.body.messages[1].content.split("あ".repeat(250)).length - 1, 12, "発言が削られている");
});

test("a prompt evaluated far below its size is flagged as server-side truncation", async () => {
  const client = { async chat() { return reply('{"message":"了解"}', { usage: { prompt_tokens: 500 } }); } };
  const statuses = [];
  const runner = new LlmRunner({ client, promptStore: new PromptStore(), onStatus: (s) => statuses.push(s) });
  const input = sampleInput();
  input.publicState.record = Array.from({ length: 20 }, () => ({ type: "speech", day: 1, round: 1, playerId: "P2", speech: "あ".repeat(250), claims: [] }));
  const result = await runner.run({
    gameId: "test", player: aiPlayer({ contextTokens: 131072 }, "werewolf"), callType: "wolf_meeting", day: 1, phase: "initial_wolf_meeting", round: null,
    input, validate: (value) => value, fallback: () => ({ message: "" }),
  });
  assert.equal(result.log.diagnostics.truncationSuspected, true);
  assert.equal(statuses.at(-1).truncationSuspected, true);
});

test("the pre-game plan checks the worst case against the context before anything is sent", () => {
  const config = defaultConfig();
  const plan = planContext(config, new PromptStore());
  assert.ok(plan.players.every((row) => row.fits), JSON.stringify(plan));
  config.players.forEach((p) => { p.llm.contextTokens = 4096; });
  assert.ok(planContext(config, new PromptStore()).players.every((row) => !row.fits));
});

test("JSON cut off by the output token limit is repaired instead of discarded", () => {
  const cut = '{"target": "P5",\n"reason": "P5の発言が曖昧で、夜の行動について何も語らないのが気にな';
  assert.deepEqual(parseJsonResponse(cut).target, "P5");
  assert.equal(JSON.parse(repairJson('{"a": 1, "b": [1, 2')).a, 1);
  assert.deepEqual(JSON.parse(repairJson('{"speech": "こんにちは", "claims": [{"type": "suspicion", "target": "P3"')).claims[0].type, "suspicion");
  // 値の来ないキーは捨てて、残りを活かす。
  assert.deepEqual(JSON.parse(repairJson('{"speech": "ここまで", "claims"')).speech, "ここまで");
  assert.deepEqual(parseJsonResponse('<think>迷う</think>\n```json\n{"type":"none","claimed_role":null}\n```').type, "none");
  assert.throws(() => parseJsonResponse("JSONではない文章です"), /not valid JSON/);
});

test("token estimation separates ascii from japanese so the budget check is not wildly off", () => {
  assert.ok(estimateTokens("あ".repeat(100)) > 80);
  assert.ok(estimateTokens("a".repeat(100)) < 30);
});
