/**
 * 実際に送るHTTPリクエストを組み立てる。ログはこの戻り値をそのまま保存し、クライアントも同じ関数で送る。
 * 送ったものとログに残るものが食い違う余地を作らないため、組み立ては必ずここ1か所で行う。
 */
export function buildChatRequest(config, messages, { responseSchema = null, maxTokens = null } = {}) {
  const baseUrl = String(config.baseUrl || "").replace(/\/$/, "");
  const api = resolveApi(config);
  const contextTokens = config.contextTokens ?? config.numCtx ?? null;
  const predict = maxTokens ?? config.maxTokens ?? 800;
  if (api === "ollama") {
    // OllamaのOpenAI互換エンドポイントは num_ctx を無視し、既定のコンテキスト長で読み込み直して入力の先頭側を黙って切り捨てる。
    // 実測で約12,400トークンの入力が2,050トークンしか評価されなかった。num_ctx が効くネイティブAPIを使う。
    return {
      api, url: `${baseUrl.replace(/\/v1$/, "")}/api/chat`,
      body: {
        model: config.model,
        messages,
        stream: false,
        format: responseSchema?.schema ?? "json",
        ...(config.think == null ? {} : { think: config.think }),
        options: {
          temperature: config.temperature ?? 0.7,
          num_predict: predict,
          ...(contextTokens ? { num_ctx: contextTokens } : {}),
          ...(config.seed == null ? {} : { seed: config.seed }),
        },
        ...(config.extra || {}),
      },
    };
  }
  return {
    api, url: `${baseUrl}/chat/completions`,
    body: {
      model: config.model,
      messages,
      temperature: config.temperature ?? 0.7,
      max_tokens: predict,
      response_format: responseSchema ? { type: "json_schema", json_schema: responseSchema } : { type: "json_object" },
      stream: false,
      ...(config.seed == null ? {} : { seed: config.seed }),
      ...(config.extra || {}),
    },
  };
}

export function resolveApi(config) {
  if (config.api === "ollama" || config.api === "openai") return config.api;
  return isLikelyOllama(String(config.baseUrl || "")) ? "ollama" : "openai";
}

export class OpenAICompatibleClient {
  async chat(config, messages, { signal, responseSchema = null, maxTokens = null } = {}) {
    if (!config.baseUrl) throw new Error("baseUrl is required");
    if (!config.model) throw new Error("model is required");
    const request = buildChatRequest(config, messages, { responseSchema, maxTokens });
    const timeout = AbortSignal.timeout(config.timeoutMs ?? 180000);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const started = performance.now();
    const response = await fetch(request.url, {
      method: "POST",
      headers: { "content-type": "application/json", ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}) },
      body: JSON.stringify(request.body), signal: combined,
    });
    const rawText = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${rawText.slice(0, 1000)}`);
    let envelope;
    try { envelope = JSON.parse(rawText); } catch { throw new Error(`API response is not JSON: ${rawText.slice(0, 500)}`); }
    const latencyMs = Math.round(performance.now() - started);
    if (request.api === "ollama") {
      const message = envelope.message;
      if (typeof message?.content !== "string") throw new Error("message.content is missing");
      const usage = { prompt_tokens: envelope.prompt_eval_count ?? null, completion_tokens: envelope.eval_count ?? null };
      return {
        content: message.content, rawEnvelope: envelope, usage,
        // 推論モデルの思考は content とは別フィールドで返る。研究用に残すが、ゲーム内には一切流さない。
        reasoning: message.thinking ?? null, finishReason: envelope.done_reason ?? null, latencyMs,
      };
    }
    const choice = envelope.choices?.[0];
    const message = choice?.message;
    if (typeof message?.content !== "string") throw new Error("choices[0].message.content is missing");
    return {
      content: message.content, rawEnvelope: envelope, usage: envelope.usage || null,
      reasoning: message?.reasoning ?? message?.reasoning_content ?? message?.thinking ?? null,
      finishReason: choice?.finish_reason ?? null, latencyMs,
    };
  }
}

function isLikelyOllama(baseUrl) {
  try {
    const url = new URL(baseUrl);
    return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname) && (url.port === "11434" || /ollama/i.test(url.pathname));
  } catch { return false; }
}

export function parseJsonResponse(content) {
  const source = stripThinking(String(content ?? ""));
  if (!source.trim()) throw new Error("モデルの出力が空です（思考だけで出力上限に達した可能性があります）");
  for (const candidate of jsonCandidates(source)) {
    const parsed = tryParse(candidate);
    if (parsed !== undefined) return parsed;
  }
  throw new Error("LLM output is not valid JSON");
}

function tryParse(text) {
  try { return JSON.parse(text); } catch {}
  const repaired = repairJson(text);
  if (repaired !== text) { try { return JSON.parse(repaired); } catch {} }
  return undefined;
}

function* jsonCandidates(source) {
  yield source.trim();
  const fenced = source.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  if (fenced) yield fenced.trim();
  const start = source.indexOf("{");
  if (start >= 0) {
    const end = source.lastIndexOf("}");
    if (end > start) yield source.slice(start, end + 1);
    // 末尾が欠けた出力（max_tokens到達）は、開き括弧以降をそのまま補完に回す。
    yield source.slice(start);
  }
}

/** 推論モデルの思考ブロックはJSONではないので落とす。 */
function stripThinking(text) {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/<think>[\s\S]*$/i, "");
}

/**
 * 途中で切れたJSONを修復する。max_tokens到達による末尾欠損が失敗の最大要因なので、
 * 末尾の不完全な要素を切り落として括弧を閉じ直し、実際にparseできた形を返す。
 */
export function repairJson(text) {
  const base = String(text ?? "").trim().replace(/^\uFEFF/, "").replace(/,(\s*[}\]])/g, "$1");
  if (!base.startsWith("{") && !base.startsWith("[")) return base;
  for (const candidate of repairCandidates(base)) {
    try { JSON.parse(candidate); return candidate; } catch {}
  }
  return base;
}

function* repairCandidates(base) {
  yield base;
  const cuts = [base.length, ...structuralCuts(base)];
  for (const cut of cuts) {
    const closed = closeStructures(base.slice(0, cut));
    if (closed) yield closed;
  }
}

/** 文字列の外側にある区切り位置（カンマ・開き括弧の直後）を後ろから列挙する。 */
function structuralCuts(text) {
  const cuts = [];
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "," || char === "{" || char === "[") cuts.push(char === "," ? i : i + 1);
  }
  return cuts.reverse();
}

/** 末尾の不完全な断片（開いた文字列・値のないキー）を落として、開いた括弧を閉じる。 */
function closeStructures(fragment) {
  const stack = [];
  let inString = false;
  let escaped = false;
  for (const char of fragment) {
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{" || char === "[") stack.push(char === "{" ? "}" : "]");
    else if (char === "}" || char === "]") stack.pop();
  }
  let result = inString ? `${fragment}"` : fragment;
  result = result.replace(/[\s,:]+$/u, "");
  // 値が来ないまま切れたキーを捨てる。
  result = result.replace(/(?:[{,])\s*"(?:[^"\\]|\\.)*"$/u, (match) => (match.trimStart().startsWith("{") ? "{" : ""));
  result = result.replace(/[\s,]+$/u, "");
  if (!result) return null;
  while (stack.length) result += stack.pop();
  return result;
}
