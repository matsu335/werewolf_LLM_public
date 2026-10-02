import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { defaultConfig } from "../src/domain/config.js";
import { GameEngine } from "../src/domain/game-engine.js";
import { Repository } from "../src/storage/repository.js";
import { LlmRunner } from "../src/llm/runner.js";
import { PromptStore } from "../src/llm/prompt-store.js";
import { GameSession } from "../src/app/game-session.js";
import { CONTROLLERS, ROLES } from "../src/domain/constants.js";

class FailingClient { async chat() { throw new Error("intentional test outage"); } }
class ControlledClient {
  constructor() { this.calls = []; }
  chat() {
    return new Promise((resolve) => this.calls.push(() => resolve({
      content: JSON.stringify({ message: "日本語の作戦提案です" }), rawEnvelope: {}, usage: null, latencyMs: 1,
    })));
  }
}

test("all-AI game reaches completion using logged fallbacks", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "werewolf-llm-"));
  const repository = new Repository(path.join(dir, "test.sqlite"));
  const config = defaultConfig();
  config.seed = 321;
  for (const player of config.players) player.llm.retries = 0;
  const engine = new GameEngine(config);
  const runner = new LlmRunner({
    client: new FailingClient(), promptStore: new PromptStore(),
    onLog: (log) => repository.saveLlmCall(log),
  });
  const session = new GameSession({ engine, repository, llmRunner: runner });
  await session.start();
  assert.equal(engine.state.status, "finished");
  assert.ok(["village", "wolf"].includes(engine.state.winner));
  const exported = repository.fullExport(engine.gameId);
  assert.ok(exported.events.length > 0);
  assert.ok(exported.llmCalls.some((call) => call.fallback));
  // Belief更新は撤去した。どの呼び出しもゲーム進行のどこからも読まれない状態を作らない。
  assert.equal(exported.llmCalls.some((call) => ["belief", "claimed_world"].includes(call.callType)), false);
  repository.close();
});

/** 呼び出し種別ごとの正しい形で答えるクライアント。スキーマ名で種別を知り、入力の「選べる相手」から対象を選ぶ。 */
class CompliantClient {
  constructor() { this.calls = []; }
  chat(_config, messages, options) {
    const callType = options.responseSchema.name.replace(/_response$/, "");
    this.calls.push({ callType, messages });
    const user = messages[1].content;
    const japanese = /自然言語の値はすべて日本語/.test(messages[0].content);
    const target = (user.match(/## (?:Players you can choose|今回選べる相手)\n(P\d+)/) ?? [])[1] ?? "P1";
    const body = {
      vote: { execute_target: target, reason: "least information so far" },
      attack: { attack_target: target, reason: "reduce information" },
      divination: { divine_target: target, reason: "not checked yet" },
      guard: { guard_target: target, reason: "likely to be attacked" },
      co: { private_thought: "wait and see", type: "none", claimed_role: null },
      discussion: { private_thought: "gather information", speech: japanese ? `${target}の考えを聞きたいです。` : `I would like to hear from ${target}.`, claims: [] },
      wolf_meeting: { message: japanese ? "方針を確認します。" : "Let us confirm the plan." },
      strategy_memory: { memory: "keep the current plan" },
    }[callType];
    return Promise.resolve({ content: JSON.stringify(body), rawEnvelope: {}, usage: null, finishReason: "stop", latencyMs: 1 });
  }
}

test("the same game runs in Japanese with Japanese prompts, input and checks, without a single fallback", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "werewolf-ja-"));
  const repository = new Repository(path.join(dir, "test.sqlite"));
  const config = defaultConfig();
  config.seed = 556;
  config.language = "ja";
  config.roleCounts = { werewolf: 2, madman: 0, seer: 1, bodyguard: 1, villager: 1 };
  for (const player of config.players) player.llm.retries = 0;
  const engine = new GameEngine(config);
  const client = new CompliantClient();
  const runner = new LlmRunner({ client, promptStore: new PromptStore(), onLog: (log) => repository.saveLlmCall(log) });
  await new GameSession({ engine, repository, llmRunner: runner }).start();
  assert.equal(engine.state.status, "finished");
  assert.deepEqual(repository.fullExport(engine.gameId).llmCalls.filter((call) => !call.success).map((call) => `${call.callType}: ${call.error}`), []);
  assert.ok(client.calls.every((call) => /## あなた\n/.test(call.messages[1].content)));
  repository.close();
});

test("a well-formed answer for every call type is accepted without a single fallback", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "werewolf-compliant-"));
  const repository = new Repository(path.join(dir, "test.sqlite"));
  const config = defaultConfig();
  config.seed = 555;
  for (const player of config.players) player.llm.retries = 0;
  const engine = new GameEngine(config);
  const runner = new LlmRunner({ client: new CompliantClient(), promptStore: new PromptStore(), onLog: (log) => repository.saveLlmCall(log) });
  await new GameSession({ engine, repository, llmRunner: runner }).start();
  assert.equal(engine.state.status, "finished");
  // プロンプト・スキーマ・検査が別々のキー名を期待していると、ここでfallbackが出る。
  const rejected = repository.fullExport(engine.gameId).llmCalls.filter((call) => ["vote", "attack", "divination", "guard"].includes(call.callType) && !call.success);
  assert.deepEqual(rejected.map((call) => `${call.callType}: ${call.error}`), []);
  repository.close();
});

test("metrics report JSON health and confirm the leak paths are closed", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "werewolf-metrics-"));
  const repository = new Repository(path.join(dir, "test.sqlite"));
  const config = defaultConfig();
  config.seed = 4242;
  for (const player of config.players) player.llm.retries = 0;
  const engine = new GameEngine(config);
  const runner = new LlmRunner({
    client: new FailingClient(), promptStore: new PromptStore(),
    onLog: (log) => repository.saveLlmCall(log),
    onStatus: (status) => engine.emit("llm_status", status, "system"),
  });
  const session = new GameSession({ engine, repository, llmRunner: runner });
  await session.start();
  const metrics = repository.metrics(engine.gameId);
  assert.equal(metrics.leakage.systemEventsInPublicView, 0);
  assert.equal(metrics.leakage.coEventsCarryingUnappliedRole, 0);
  // APIが落ちていても、空発言ではなく保留発言が入る。
  assert.equal(metrics.leakage.emptySpeeches, 0);
  assert.ok(metrics.leakage.speechCount > 0);
  assert.equal(metrics.calls.jsonSuccessRate, 0);
  assert.ok(metrics.calls.fallbacks > 0);
  assert.ok(Object.hasOwn(metrics.calls.byCallType, "discussion"));
  repository.close();
});

test("simultaneous discussion mode collects every speech from one snapshot", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "werewolf-simultaneous-"));
  const repository = new Repository(path.join(dir, "test.sqlite"));
  const config = defaultConfig();
  config.seed = 909;
  config.discussionMode = "simultaneous";
  for (const player of config.players) player.llm.retries = 0;
  const engine = new GameEngine(config);
  const runner = new LlmRunner({ client: new FailingClient(), promptStore: new PromptStore() });
  const session = new GameSession({ engine, repository, llmRunner: runner });
  await session.start();
  assert.equal(engine.state.status, "finished");
  const day1 = engine.events.filter((event) => event.type === "speech" && event.day === 1);
  assert.equal(day1.length, 10, "5人×2巡の発言が揃っていない");
  repository.close();
});

test("all-Human game pauses for each action and can be played to completion", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "werewolf-human-"));
  const repository = new Repository(path.join(dir, "test.sqlite"));
  const base = defaultConfig();
  const fixedRoles = [ROLES.WEREWOLF, ROLES.SEER, ROLES.BODYGUARD, ROLES.VILLAGER];
  base.seed = 77;
  base.roleCounts = { werewolf: 1, seer: 1, bodyguard: 1, villager: 1, madman: 0 };
  base.players = fixedRoles.map((role, i) => ({
    id: `P${i + 1}`, name: `Human ${i + 1}`, controller: CONTROLLERS.HUMAN,
    fixedRole: role, llm: null,
  }));
  const engine = new GameEngine(base);
  const runner = new LlmRunner({ client: new FailingClient(), promptStore: new PromptStore() });
  const session = new GameSession({ engine, repository, llmRunner: runner });
  await session.start();
  session.requestPause();
  assert.equal(engine.state.paused, true);
  const firstPending = clone(engine.state.pending);
  await assert.rejects(() => session.submitHumanAction(firstPending.required[0], firstPending.kind, { type: "none" }), /一時停止中/);
  session.resume();
  assert.equal(engine.state.paused, false);
  let safety = 0;
  while (engine.state.status !== "finished" && safety++ < 100) {
    const pending = clone(engine.state.pending);
    assert.ok(pending, `game is running without a Human prompt at ${engine.state.phase}`);
    for (const id of pending.required) {
      const value = humanValue(pending.kind, session, id);
      await session.submitHumanAction(id, pending.kind, value);
    }
  }
  assert.equal(engine.state.status, "finished");
  assert.ok(engine.events.some((event) => event.type === "speech"));
  assert.ok(engine.events.some((event) => event.type === "vote_cast"));
  assert.ok(engine.events.some((event) => event.type === "divination_result"));
  repository.close();
});

test("a running game can be force-terminated, persisted, and deleted from archive", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "werewolf-control-"));
  const repository = new Repository(path.join(dir, "test.sqlite"));
  const config = defaultConfig();
  config.players.forEach((player) => { player.controller = CONTROLLERS.HUMAN; player.llm = null; });
  const engine = new GameEngine(config);
  const runner = new LlmRunner({ client: new FailingClient(), promptStore: new PromptStore() });
  const session = new GameSession({ engine, repository, llmRunner: runner });
  await session.start();
  session.forceTerminate();
  assert.equal(engine.state.status, "finished");
  assert.equal(engine.state.winner, "terminated");
  assert.equal(repository.getGame(engine.gameId).state.winner, "terminated");
  assert.equal(repository.deleteGame(engine.gameId), true);
  assert.equal(repository.getGame(engine.gameId), null);
  assert.equal(repository.fullExport(engine.gameId), null);
  repository.close();
});

test("pause prevents every new serial LLM call after the currently running call", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "werewolf-pause-"));
  const repository = new Repository(path.join(dir, "test.sqlite"));
  const config = defaultConfig();
  config.players.forEach((player) => { player.llm.retries = 0; });
  const engine = new GameEngine(config);
  const client = new ControlledClient();
  const runner = new LlmRunner({ client, promptStore: new PromptStore() });
  const session = new GameSession({ engine, repository, llmRunner: runner });
  session.schedule(session.start);
  await waitUntil(() => client.calls.length === 1);
  session.requestPause();
  client.calls[0]();
  await waitUntil(() => engine.state.paused === true);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(client.calls.length, 1, "a second LLM call started while paused");
  session.resume();
  await waitUntil(() => client.calls.length === 2);
  session.forceTerminate();
  client.calls[1]();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(engine.state.winner, "terminated");
  repository.close();
});

test("with a single werewolf there is no meeting, so no strategy memo is ever requested", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "werewolf-lonewolf-"));
  const repository = new Repository(path.join(dir, "test.sqlite"));
  const config = defaultConfig();
  config.seed = 31;
  for (const player of config.players) player.llm.retries = 0;
  const engine = new GameEngine(config);
  const client = new CompliantClient();
  await new GameSession({ engine, repository, llmRunner: new LlmRunner({ client, promptStore: new PromptStore() }) }).start();
  assert.equal(engine.state.status, "finished");
  // 会議が無いのに「会議を要約せよ」と呼ぶと、盤面を持たないモデルが計画を捏造して以降の入力を汚した。
  assert.deepEqual(client.calls.filter((c) => ["wolf_meeting", "strategy_memory"].includes(c.callType)), []);
  repository.close();
});

test("with two werewolves the memo follows a meeting and is written with the board in view", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "werewolf-pack-"));
  const repository = new Repository(path.join(dir, "test.sqlite"));
  const config = defaultConfig();
  config.seed = 32;
  config.roleCounts = { werewolf: 2, madman: 0, seer: 1, bodyguard: 1, villager: 1 };
  for (const player of config.players) player.llm.retries = 0;
  const engine = new GameEngine(config);
  const client = new CompliantClient();
  await new GameSession({ engine, repository, llmRunner: new LlmRunner({ client, promptStore: new PromptStore() }) }).start();
  const memoCalls = client.calls.filter((c) => c.callType === "strategy_memory");
  assert.ok(memoCalls.length > 0);
  for (const call of memoCalls) {
    assert.match(call.messages[1].content, /## Secret werewolf meeting/);
    assert.match(call.messages[1].content, /## Players \(seat order\)/);
    assert.match(call.messages[1].content, /Let us confirm the plan\./);
  }
  repository.close();
});

test("an input that no longer fits the context ends the game instead of trimming or guessing", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "werewolf-overflow-"));
  const repository = new Repository(path.join(dir, "test.sqlite"));
  const config = defaultConfig();
  config.seed = 33;
  for (const player of config.players) Object.assign(player.llm, { retries: 0, contextTokens: 3000 });
  const engine = new GameEngine(config);
  const client = new CompliantClient();
  await new GameSession({ engine, repository, llmRunner: new LlmRunner({ client, promptStore: new PromptStore() }) }).start();
  assert.equal(engine.state.status, "finished");
  assert.equal(engine.state.winner, "terminated");
  assert.match(engine.state.winningReason, /コンテキスト長に収まりません/);
  assert.equal(client.calls.length, 0);
  assert.ok(engine.events.some((e) => e.type === "system_error" && e.payload.kind === "ContextOverflowError"));
  repository.close();
});

function humanValue(kind, session, id) {
  if (kind === "co") return { type: "none" };
  if (kind === "speech") return { speech: `${id} is speaking.`, claims: [] };
  if (kind === "vote") return { target: session.engine.livingIds().at(-1) };
  if (kind === "wolf_meeting") return { message: "Confirming the attack plan." };
  if (kind === "night_action") return { target: session.validNightTargets(id)[0] };
  throw new Error(`Unexpected kind: ${kind}`);
}

function clone(value) { return structuredClone(value); }

async function waitUntil(predicate, timeoutMs = 2000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
