import { buildChatRequest, parseJsonResponse } from "./openai-client.js";
import { renderInput } from "./input-renderer.js";
import { text } from "./messages.js";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 呼び出し種別ごとのJSON本体の予算。全部を同じmax_tokensで回すと長い理由文で末尾が切れてJSONが壊れる。 */
const ANSWER_TOKENS = {
  co: 320, discussion: 1200, vote: 320, attack: 320, divination: 320, guard: 320,
  wolf_meeting: 400, strategy_memory: 500,
};

const DEFAULT_CONTEXT_TOKENS = 20480;
// 推論モデルの思考はJSON本体より先に出るため、ここを確保しないと本体が出る前に打ち切られる。
// qwen3:8bの思考は実測で最大12,700文字（英語で約3,200トークン）に達するため、実測値を基準に取る。
const DEFAULT_REASONING_TOKENS = 4096;
const MAX_REASONING_TOKENS = 8192;
// トークン数は自前の見積りなので、実際の値との誤差ぶんを空けておく。
const SAFETY_MARGIN_TOKENS = 256;
const NEAR_LIMIT_RATIO = 0.8;

/**
 * 入力がコンテキストに収まらない。入力を削って送るとモデルの視界が黙って欠けるため、送らずに試合を止める。
 */
export class ContextOverflowError extends Error {
  constructor(details) {
    super(`入力がコンテキスト長に収まりません（${details.playerId} / ${details.callType}: 必要 ${details.requiredTokens} > 上限 ${details.contextTokens} トークン）。contextTokens を増やしてください`);
    this.name = "ContextOverflowError";
    this.details = details;
  }
}

export class LlmRunner {
  constructor({ client, promptStore, onStatus = () => {}, onLog = () => {} }) {
    this.client = client;
    this.promptStore = promptStore;
    this.onStatus = onStatus;
    this.onLog = onLog;
  }

  async run(spec) {
    const { gameId, player, callType, day, phase, validate, fallback } = spec;
    const language = spec.language ?? "ja";
    const config = player.llm;
    const bundle = this.promptStore.bundle(callType, player.role, language);
    const userText = renderInput({ ...spec.input, task: { ...spec.input?.task, callType } }, language);
    const baseMessages = [
      { role: "system", content: bundle.system },
      { role: "user", content: userText },
    ];
    const answerTokens = ANSWER_TOKENS[callType] ?? config.maxTokens ?? 800;
    let reasoningTokens = config.reasoningTokens ?? DEFAULT_REASONING_TOKENS;
    let outputTokens = answerTokens + reasoningTokens;
    const contextTokens = config.contextTokens ?? config.numCtx ?? DEFAULT_CONTEXT_TOKENS;
    const inputTokens = estimateMessages(baseMessages);
    const requiredTokens = inputTokens + outputTokens + SAFETY_MARGIN_TOKENS;
    const budget = { contextTokens, inputTokens, requiredTokens, nearLimit: requiredTokens > contextTokens * NEAR_LIMIT_RATIO };
    if (requiredTokens > contextTokens) {
      const error = new ContextOverflowError({ playerId: player.id, callType, contextTokens, requiredTokens, inputTokens, outputTokens });
      this.onStatus({ gameId, playerId: player.id, callType, status: "context_overflow", error: error.message, day, phase });
      throw error;
    }
    const maxRetries = Math.max(0, config.retries ?? 2);
    const schema = schemaForCall(callType, language);
    let lastError = null;
    let lastRaw = null;
    let lastParsed = null;
    let repairHint = null;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      if (spec.beforeAttempt) await spec.beforeAttempt({ attempt });
      const status = attempt === 0 ? "processing" : "retry";
      this.onStatus({ gameId, playerId: player.id, callType, status, attempt, day, phase });
      const startedAt = new Date().toISOString();
      const started = performance.now();
      // リトライは同じ入力の投げ直しではなく、前回出力と却下理由を渡した修復依頼にする。
      const messages = repairHint ? [...baseMessages, { role: "user", content: repairHint }] : baseMessages;
      const options = { responseSchema: schema, maxTokens: outputTokens };
      // 実際に送るものをそのまま記録する。GUIはこれを役割付きで順に描き、送信内容を一字一句再現する。
      const request = buildChatRequest(config, messages, options);
      let response = null;
      try {
        response = await this.client.chat(config, messages, options);
        lastRaw = response.content;
        const diagnostics = analyze({ response, messages, budget, outputTokens, reasoningTokens });
        const parsed = parseJsonResponse(response.content);
        lastParsed = parsed;
        const value = validate(parsed);
        const log = makeLog({
          spec, config, bundle, language, request, startedAt, latencyMs: response.latencyMs ?? Math.round(performance.now() - started),
          response, parsedResponse: parsed, acceptedValue: value, success: true, attempt, diagnostics,
        });
        this.onLog(log);
        this.onStatus({ gameId, playerId: player.id, callType, status: "success", attempt, day, phase, ...statusDiagnostics(diagnostics) });
        return { value, log, diagnostics };
      } catch (error) {
        lastError = error;
        const diagnostics = analyze({ response, messages, budget, outputTokens, reasoningTokens });
        repairHint = buildRepairHint(language, response?.content ?? null, error.message, diagnostics);
        // 枠切れは入力ではなく予算の問題。思考枠を広げて同じ問いをもう一度出す。
        const ceiling = reasoningHeadroom(contextTokens, estimateMessages(messages), answerTokens, config.reasoningTokens);
        if (diagnostics.outputTruncated && reasoningTokens < ceiling) {
          reasoningTokens = Math.min(ceiling, reasoningTokens * 2);
          outputTokens = answerTokens + reasoningTokens;
        }
        this.onLog(makeLog({
          spec, config, bundle, language, request, startedAt, latencyMs: Math.round(performance.now() - started),
          response, parsedResponse: lastParsed && response?.content === lastRaw ? lastParsed : null,
          success: false, attempt, error: error.message, diagnostics,
        }));
        this.onStatus({ gameId, playerId: player.id, callType, status: attempt < maxRetries ? "retry" : "failure", attempt, error: error.message, day, phase, ...statusDiagnostics(diagnostics) });
        if (attempt < maxRetries) await wait(Math.min(250 * 2 ** attempt, 2000));
      }
    }
    // 検証は通らなかったが解析できた出力を渡す。内容を丸ごと捨てないための救済経路。
    const value = fallback(lastError, { lastParsed, lastRaw });
    // この記録はLLMへの送信ではない。採用した代替値を残すための行で、request は持たない。
    const log = makeLog({
      spec, config, bundle, language, request: null, startedAt: new Date().toISOString(), latencyMs: 0,
      response: null, parsedResponse: null, fallbackValue: value, success: false, attempt: maxRetries, fallback: true,
      error: lastError?.message, diagnostics: null,
    });
    this.onLog(log);
    this.onStatus({ gameId, playerId: player.id, callType, status: "fallback", attempt: maxRetries, error: lastError?.message, day, phase });
    return { value, log };
  }

  async batch(specs, mode = "serial") {
    // Each spec must already contain an immutable input snapshot. Serial controls compute only.
    if (mode === "parallel") return Promise.all(specs.map((spec) => this.run(spec)));
    const results = [];
    for (const spec of specs) results.push(await this.run(spec));
    return results;
  }
}

/**
 * 実際に送る入力を差し引いた、思考に回せるトークン数の上限。
 * 思考枠を広く設定した場合（推論の強さを上げたOpenAIのモデルなど）は、その2倍までは広げられるようにする。
 */
function reasoningHeadroom(contextTokens, inputTokens, answerTokens, configuredReasoningTokens = null) {
  const cap = Math.max(MAX_REASONING_TOKENS, (configuredReasoningTokens ?? 0) * 2);
  return Math.max(0, Math.min(cap, contextTokens - inputTokens - answerTokens - SAFETY_MARGIN_TOKENS));
}

/** 日本語混在テキストのざっくりしたトークン見積り。予算判定と切り捨て検知に使う。 */
export function estimateTokens(value) {
  const source = String(value ?? "");
  let cjk = 0;
  for (const char of source) if (/[^\x00-\x7F]/u.test(char)) cjk += 1;
  return Math.ceil((source.length - cjk) / 4 + cjk / 1.1);
}

// メッセージごとにチャットテンプレートの区切りトークンが付くので、その分を上乗せする。
export function estimateMessages(messages) {
  return messages.reduce((sum, message) => sum + estimateTokens(message.content) + 8, 0);
}

function analyze({ response, messages, budget, outputTokens = null, reasoningTokens = null }) {
  const usage = response?.usage ?? response?.rawEnvelope?.usage ?? null;
  const estimatedPromptTokens = estimateMessages(messages);
  const reportedPromptTokens = usage?.prompt_tokens ?? null;
  // 送った量より明らかに少ないトークンしか評価されていなければ、推論サーバ側で切り捨てられている。
  const truncationSuspected = reportedPromptTokens != null && estimatedPromptTokens > 512
    && reportedPromptTokens < estimatedPromptTokens * 0.7;
  const finishReason = response?.finishReason ?? response?.rawEnvelope?.choices?.[0]?.finish_reason ?? null;
  return {
    promptChars: messages.reduce((sum, message) => sum + String(message.content).length, 0),
    estimatedPromptTokens,
    reportedPromptTokens,
    contextTokens: budget.contextTokens,
    requiredTokens: budget.requiredTokens,
    contextNearLimit: budget.nearLimit,
    truncationSuspected,
    finishReason,
    outputTruncated: finishReason === "length",
    outputTokenBudget: outputTokens,
    reasoningTokenBudget: reasoningTokens,
    reasoningChars: String(response?.reasoning ?? "").length,
    // OpenAIは思考の本文を返さず、トークン数だけを報告する。
    reportedReasoningTokens: usage?.completion_tokens_details?.reasoning_tokens ?? null,
    emptyContent: !String(response?.content ?? "").trim(),
  };
}

function statusDiagnostics(diagnostics) {
  const flags = {};
  if (diagnostics?.truncationSuspected) flags.truncationSuspected = true;
  if (diagnostics?.outputTruncated) flags.outputTruncated = true;
  if (diagnostics?.contextNearLimit) flags.contextNearLimit = true;
  return flags;
}

/**
 * 却下されたときだけ付ける修復依頼。
 * 思考の抑制は絶対に依頼しない。抑制させると、推論を伴わない定型出力（プレイヤーを
 * A・B・J と呼ぶ、最も言及数の多いIDへ投票する等）が本番の発言や投票として記録され、
 * 観察しているのがモデルの判断ではなく修復ループの副作用になってしまう。
 */
function buildRepairHint(language, rawResponse, errorMessage, diagnostics) {
  // 出力枠の使い切りはモデルの判断の問題ではなく予算の問題。何も指摘せず、広い枠で同じ問いを出し直す。
  if (diagnostics?.emptyContent) return null;
  const t = text(language);
  const lines = [t.repairHeader, t.repairReason(errorMessage)];
  if (diagnostics?.outputTruncated) lines.push(t.repairTruncated);
  if (rawResponse) lines.push(t.repairPrevious(String(rawResponse).slice(0, 1200)));
  return lines.join("\n");
}

function makeLog({ spec, config, bundle, language, request, startedAt, latencyMs, response, parsedResponse, acceptedValue = null, fallbackValue = null, success, attempt, fallback = false, error = null, diagnostics = null }) {
  return {
    id: crypto.randomUUID(), gameId: spec.gameId, playerId: spec.player.id,
    trueRole: spec.player.role, controllerType: spec.player.controller, day: spec.day,
    phase: spec.phase, round: spec.round ?? null, callType: spec.callType, language,
    model: config.model, baseUrl: redactUrl(config.baseUrl),
    // 考える量の設定。モデルの能力と区別して分析できるよう、呼び出しごとに残す（未指定はモデルの既定値）。
    reasoningEffort: config.reasoningEffort ?? null,
    promptFiles: bundle.files,
    // input は描き起こし前の構造化データ（分析用）。LLMが実際に読んだものは request.body.messages にある。
    input: spec.input,
    request: request && { ...request, url: redactUrl(request.url) },
    rawResponse: response?.content ?? null, reasoning: response?.reasoning ?? null, apiEnvelope: response?.rawEnvelope ?? null,
    parsedResponse, acceptedValue, fallbackValue,
    timestamp: startedAt, latencyMs, tokenUsage: response?.usage ?? null,
    diagnostics, success, retryAttempt: attempt, fallback, error,
  };
}

function redactUrl(value) {
  try { const url = new URL(value); url.username = ""; url.password = ""; return url.toString().replace(/\/$/, ""); }
  catch { return String(value || ""); }
}

/**
 * 文字数の上限。日本語は文字数、英語は語数でプロンプトに指定し、ここはその上に取る機械的な上限。
 * プロンプトの値ちょうどにすると、上限を目指して書いた文が最後の一文の途中で切られ、研究データとして読めなくなる。
 */
const LIMITS = {
  ja: { thought: 300, speech: 500, claimValue: 60, reason: 140, message: 200, memory: 400 },
  en: { thought: 400, speech: 1600, claimValue: 100, reason: 300, message: 400, memory: 800 },
};

function schemaForCall(callType, language = "ja") {
  const limit = LIMITS[language] || LIMITS.ja;
  const nullableRole = { type: ["string", "null"], enum: [null, "villager", "seer", "bodyguard", "madman", "werewolf"] };
  const thought = { type: "string", maxLength: limit.thought };
  const closed = (properties) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
  const schemas = {
    co: {
      strict: true,
      schema: closed({
        private_thought: thought,
        type: { type: "string", enum: ["none", "declare", "withdraw", "change"] },
        claimed_role: nullableRole,
      }),
    },
    discussion: {
      strict: true,
      schema: closed({
        private_thought: thought,
        // COしてから話す順に並べる。発言の中で名乗れるのは、この co 欄を適用した後のCOだけ。
        co: closed({ type: { type: "string", enum: ["none", "declare", "withdraw", "change"] }, claimed_role: nullableRole }),
        speech: { type: "string", maxLength: limit.speech },
        claims: {
          type: "array", maxItems: 4,
          items: closed({
            type: { type: "string", enum: ["divination_result", "guard", "suspicion", "trust", "other"] },
            target: { type: ["string", "null"] },
            value: { type: "string", maxLength: limit.claimValue },
          }),
        },
      }),
    },
    vote: targetSchema("execute_target", limit), attack: targetSchema("attack_target", limit),
    divination: targetSchema("divine_target", limit), guard: targetSchema("guard_target", limit),
    wolf_meeting: textSchema("message", limit.message), strategy_memory: textSchema("memory", limit.memory),
  };
  const entry = schemas[callType] || { strict: false, schema: { type: "object" } };
  return { name: `${callType}_response`, strict: entry.strict, schema: entry.schema };
}

/**
 * 対象を1人選ぶ呼び出しのスキーマ。キー名は呼び出し種別ごとに変える。
 * 投票と夜行動が同じ {target} 形式だったとき、狩人が処刑投票を「護衛先の指名」として
 * 埋めて村を1人失わせる事故が起きた。何を選んでいるのかをキー名自体に持たせて防ぐ。
 */
function targetSchema(key, limit) {
  return {
    strict: true,
    schema: {
      type: "object",
      // 候補を1人に絞れず "P4 and P5" と書いてくる。誰を選ぶかではなく形式の問題なので文法で縛る。
      properties: { [key]: { type: "string", pattern: "^P[0-9]{1,3}$" }, reason: { type: "string", maxLength: limit.reason } },
      required: [key, "reason"], additionalProperties: false,
    },
  };
}

function textSchema(key, maxLength) {
  return {
    strict: true,
    schema: { type: "object", properties: { [key]: { type: "string", maxLength } }, required: [key], additionalProperties: false },
  };
}
