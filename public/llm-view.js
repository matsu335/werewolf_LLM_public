import { txHtml } from "./translation.js";

/**
 * LLM呼び出し1試行の表示。送信内容は request.body.messages をそのまま役割付きで順に描く。
 * これはLLMが実際に読んだものと一字一句同じで、修復依頼（3通目以降）も含む。
 */
const parallel = new Map();
let rerender = () => {};

export function setLlmViewRerender(fn) { rerender = fn; }

export function chatLlmCallHtml(call, { esc, callTypeNames }) {
  const label = callTypeNames[call.callType] || call.callType;
  const key = `llm-${call.id}`;
  const head = (state, cls) => `<div class="chat-meta"><strong>${esc(call.playerId)} · ${esc(label)}</strong><span>Day ${call.day} · <span class="pill ${cls}">${state}</span></span></div>`;
  if (call.fallback) {
    return wrap(`${head("Fallback", "error")}<div class="chat-bubble"><div class="chat-llm-notes">LLMへの送信はありません。すべての試行が却下されたため、代替値を採用しました。</div>${call.error ? `<div class="chat-llm-error">最後の却下理由: ${esc(call.error)}${txHtml(call.error, esc)}</div>` : ""}<details data-state-key="${key}-value"><summary>採用した代替値</summary><pre class="event-json">${esc(JSON.stringify(call.fallbackValue ?? call.parsedResponse ?? null, null, 2))}</pre></details></div>`);
  }
  const d = call.diagnostics || {};
  const notes = [`試行${(call.retryAttempt ?? 0) + 1}回目`, `${call.latencyMs ?? 0}ms`, `入力${d.promptChars ?? 0}字（推定${d.estimatedPromptTokens ?? "?"}トークン${d.reportedPromptTokens != null ? `・評価${d.reportedPromptTokens}` : ""}）`, `思考${d.reasoningChars ?? 0}字`];
  if (d.finishReason) notes.push(`finish: ${d.finishReason}`);
  const flags = [];
  if (d.outputTruncated) flags.push("出力が枠切れ");
  if (d.truncationSuspected) flags.push("入力切り捨て疑い");
  if (d.contextNearLimit) flags.push(`コンテキストの8割超（必要${d.requiredTokens} / ${d.contextTokens}）`);
  if (d.compaction?.level) flags.push(`旧形式: 入力圧縮Lv${d.compaction.level}`);
  const state = call.success ? "成功" : "却下";
  const request = call.request ? requestHtml(call, key, esc) : legacyRequestHtml(call, key, esc);
  const reasoning = call.reasoning || "";
  const body = `${head(state, call.success ? "" : "error")}<div class="chat-bubble"><div class="chat-llm-notes">${notes.map(esc).join(" · ")}</div>${flags.length ? `<div class="chat-llm-error">${flags.map(esc).join(" · ")}</div>` : ""}${call.error ? `<div class="chat-llm-error">却下理由: ${esc(call.error)}${txHtml(call.error, esc)}</div>` : ""}${request}<details data-state-key="${key}-out"><summary>出力（生テキスト全文）</summary><pre class="event-json">${esc(call.rawResponse ?? "（なし）")}</pre>${txHtml(outputText(call), esc)}</details>${call.success ? `<details data-state-key="${key}-accepted"><summary>採用された値</summary><pre class="event-json">${esc(JSON.stringify(call.acceptedValue ?? call.parsedResponse ?? null, null, 2))}</pre></details>` : ""}<details data-state-key="${key}-thinking"><summary>思考（${reasoning.length}字・他プレイヤーには渡らない）</summary><pre class="event-json">${esc(reasoning || "（なし）")}</pre>${txHtml(reasoning, esc)}</details></div>`;
  return wrap(body);
}

function wrap(inner) {
  return `<div class="chat-message llm"><div class="chat-avatar">AI</div><div class="chat-content">${inner}</div></div>`;
}

/** 出力のうち自然言語の部分。JSONのキーまで訳すと読みにくいので、値だけを並べる。 */
export function outputText(call) {
  const value = call.parsedResponse;
  if (!value || typeof value !== "object") return call.rawResponse || "";
  const lines = [];
  const walk = (v, path) => {
    if (typeof v === "string" && /[a-z]{3,}\s+[a-z]/iu.test(v)) lines.push(`${path}: ${v}`);
    else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, path ? `${path}.${k}` : k);
  };
  walk(value, "");
  return lines.join("\n");
}

function requestHtml(call, key, esc) {
  const { api, url, body } = call.request;
  const messages = body.messages || [];
  const constraint = api === "ollama" ? { format: body.format, think: body.think } : { response_format: body.response_format };
  const params = api === "ollama"
    ? { model: body.model, ...body.options, ...(body.think == null ? {} : { think: body.think }) }
    : { model: body.model, temperature: body.temperature, seed: body.seed, max_tokens: body.max_tokens };
  const rest = Object.fromEntries(Object.entries(body).filter(([k]) => !["messages", "format", "response_format", "options", "model", "temperature", "seed", "max_tokens", "think", "stream"].includes(k)));
  const table = Object.entries(params).filter(([, v]) => v !== undefined).map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(typeof v === "object" ? JSON.stringify(v) : v)}</td></tr>`).join("");
  const japanese = call.language && call.language !== "ja";
  const cached = parallel.get(call.id);
  const rendered = messages.map((m, i) => {
    const role = i === 0 ? "system" : i === 1 ? "user（状況）" : "user（修復依頼）";
    const ja = cached?.messages?.[i];
    const button = japanese && i < 2 && !cached ? `<button class="btn secondary small" data-parallel="${esc(call.id)}" data-game="${esc(call.gameId)}">日本語版を表示</button>` : "";
    const jaBlock = ja?.content ? `<div class="tx-ja"><div class="tx-label">日本語版（翻訳ではなく、同じ入力を日本語のテンプレートとプロンプトで描き直したもの）</div><pre class="event-json">${esc(ja.content)}</pre></div>` : "";
    return `<div class="llm-msg"><div class="llm-msg-head"><span class="pill">${esc(m.role)}</span> ${esc(role)} · ${String(m.content).length}字 ${button}</div><pre class="event-json">${esc(m.content)}</pre>${jaBlock}${i >= 2 && japanese ? txHtml(m.content, esc) : ""}</div>`;
  }).join("");
  return `<details data-state-key="${key}-in"><summary>送信内容（${messages.length}通・LLMが実際に読んだものと同一）</summary><div class="llm-request"><div class="llm-endpoint">${esc(api)} · ${esc(url)}</div><table class="llm-params">${table}</table><details data-state-key="${key}-constraint"><summary>出力の拘束（${api === "ollama" ? "format" : "response_format"}）</summary><pre class="event-json">${esc(JSON.stringify(constraint, null, 2))}</pre></details>${Object.keys(rest).length ? `<details data-state-key="${key}-extra"><summary>その他の送信パラメータ</summary><pre class="event-json">${esc(JSON.stringify(rest, null, 2))}</pre></details>` : ""}${rendered}</div></details>`;
}

/** 送信内容を丸ごと記録する前のログ。system と input しか残っておらず、修復依頼は復元できない。 */
function legacyRequestHtml(call, key, esc) {
  return `<details data-state-key="${key}-in"><summary>送信内容（旧形式のログ）</summary><div class="chat-llm-error">このログは送信内容をそのまま記録する前の形式です。修復依頼（3通目）と出力の拘束パラメータは記録されていません。</div><div class="llm-msg"><div class="llm-msg-head"><span class="pill">system</span></div><pre class="event-json">${esc(call.systemPrompt || "（記録なし）")}</pre></div><div class="llm-msg"><div class="llm-msg-head"><span class="pill">user</span></div><pre class="event-json">${esc(call.inputPrompt || "（記録なし）")}</pre></div></details>`;
}

export async function handleParallelClick(event) {
  const button = event.target.closest?.("[data-parallel]");
  if (!button) return false;
  const id = button.dataset.parallel;
  button.disabled = true;
  try {
    const response = await fetch(`/api/games/${button.dataset.game}/calls/${id}/japanese`);
    parallel.set(id, await response.json());
  } finally {
    rerender();
  }
  return true;
}
