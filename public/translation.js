/**
 * 観察用の日本語訳。厳密さより「何を言っているかを一瞬でつかむ」ためのもの。
 * 既定はブラウザ内蔵の翻訳（Translator API。端末内で処理し外部へ送らない）で、使えない環境では
 * サーバーに DEEPL_API_KEY があればそちらを使う。訳文は表示とキャッシュにしか使わず、
 * ゲーム状態やLLMへの入力へは一切戻さない。
 */
const SOURCE = "en";
const TARGET = "ja";
const MODE_KEY = "werewolf.translationMode";

const tx = {
  cache: new Map(), pending: new Set(), failed: new Map(), sources: new Map(), queue: [], busy: false,
  translator: null, availability: "unknown", server: null, progress: null, message: "",
  batchedFor: new Set(), rerender: () => {},
  mode: readMode(),
};

function readMode() {
  try { return localStorage.getItem(MODE_KEY) === "live" ? "live" : "click"; } catch { return "click"; }
}

export function translationMode() { return tx.mode; }
export function setRerender(fn) { tx.rerender = fn; }

export async function initTranslation() {
  try { tx.server = (await (await fetch("/api/translation/provider")).json()).server; } catch { tx.server = null; }
  if (!("Translator" in self)) { tx.availability = "unsupported"; return; }
  // APIが存在しても応答しない環境がある（埋め込みのChromiumで確認）。待ち続けて画面が「確認中」のまま固まらないようにする。
  try { tx.availability = await withTimeout(self.Translator.availability({ sourceLanguage: SOURCE, targetLanguage: TARGET }), 5000); }
  catch { tx.availability = "no_response"; }
}

function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error("ブラウザ内蔵翻訳が応答しません")), ms))]);
}

const hasJapanese = (value) => /[぀-ヿ㐀-鿿]/u.test(value);

/** 訳を付ける対象か。日本語の試合の文や空文字には付けない。 */
function translatable(value) {
  return typeof value === "string" && value.trim() && !hasJapanese(value);
}

function key(value) {
  let h = 5381;
  for (let i = 0; i < value.length; i += 1) h = ((h << 5) + h + value.charCodeAt(i)) | 0;
  return `t${(h >>> 0).toString(36)}${value.length}`;
}

export function txHtml(value, esc) {
  if (!translatable(value)) return "";
  const id = key(value);
  tx.sources.set(id, value);
  if (tx.cache.has(value)) {
    return `<div class="tx-ja"><div class="tx-label">日本語訳（機械翻訳・観察用）</div><div class="tx-body">${esc(tx.cache.get(value))}</div></div>`;
  }
  if (tx.pending.has(value)) return `<div class="tx-pending">翻訳中…</div>`;
  const failed = tx.failed.get(value);
  return `<button class="tx-btn" data-tx="${id}">日本語訳${failed ? `（失敗: ${esc(failed)}）` : ""}</button>`;
}

export function toolbarHtml(esc) {
  const browser = {
    available: "ブラウザ内蔵翻訳: 利用可能",
    downloadable: "ブラウザ内蔵翻訳: 初回のみ言語モデルのダウンロードが必要（翻訳ボタンのクリックで開始）",
    downloading: `ブラウザ内蔵翻訳: ダウンロード中${tx.progress != null ? ` ${tx.progress}%` : ""}`,
    unavailable: "ブラウザ内蔵翻訳: この言語の組み合わせは使えません",
    unsupported: "ブラウザ内蔵翻訳: このブラウザは非対応（デスクトップ版Chrome 138以降で利用可）",
    no_response: "ブラウザ内蔵翻訳: APIが応答しません（通常のChromeで開いてください）",
    unknown: "ブラウザ内蔵翻訳: 確認中",
  }[tx.availability] ?? `ブラウザ内蔵翻訳: ${tx.availability}`;
  const server = tx.server ? `サーバー翻訳: ${tx.server}` : "サーバー翻訳: 未設定";
  const queue = tx.queue.length || tx.busy ? ` · 残り ${tx.queue.length + (tx.busy ? 1 : 0)} 件` : "";
  return `<div class="tx-toolbar"><label>日本語訳<select id="tx-mode"><option value="click" ${tx.mode === "click" ? "selected" : ""}>クリック時＋試合後に一括</option><option value="live" ${tx.mode === "live" ? "selected" : ""}>試合中も自動</option></select></label><button class="btn secondary small" id="tx-all">未翻訳をすべて訳す</button><span class="tx-status">${esc(browser)} · ${esc(server)}${esc(queue)}${tx.message ? ` · ${esc(tx.message)}` : ""}</span></div>`;
}

export function bindToolbar(root, collect) {
  root.querySelector("#tx-mode")?.addEventListener("change", (event) => {
    tx.mode = event.target.value;
    try { localStorage.setItem(MODE_KEY, tx.mode); } catch { /* 保存できなくても今回の表示には使える */ }
    if (tx.mode === "live") enqueue(collect());
    tx.rerender();
  });
  root.querySelector("#tx-all")?.addEventListener("click", () => enqueue(collect()));
}

/** 翻訳ボタンのクリック。クリックはユーザー操作なので、初回の言語モデルのダウンロードもここで始められる。 */
export function handleTranslationClick(event) {
  const button = event.target.closest?.("[data-tx]");
  if (!button) return false;
  const value = tx.sources.get(button.dataset.tx);
  if (value) enqueue([value], { front: true });
  return true;
}

/**
 * 試合後の一括と、試合中の自動翻訳。一括は試合ごとに一度だけ自動で始める。
 * 言語モデルのダウンロードが必要な状態ではユーザー操作なしに始められないので、ボタンを待つ。
 */
export function autoTranslate(gameId, finished, collect) {
  if (tx.mode === "live" || (finished && !tx.batchedFor.has(gameId))) {
    if (finished) tx.batchedFor.add(gameId);
    if (tx.availability === "available" || tx.translator || tx.server) enqueue(collect());
  }
}

export function enqueue(values, { front = false } = {}) {
  const fresh = [...new Set(values)].filter((v) => translatable(v) && !tx.cache.has(v) && !tx.pending.has(v) && !tx.queue.includes(v));
  if (!fresh.length) return;
  if (front) tx.queue.unshift(...fresh); else tx.queue.push(...fresh);
  for (const v of fresh) tx.pending.add(v);
  tx.rerender();
  pump();
}

async function pump() {
  if (tx.busy) return;
  tx.busy = true;
  try {
    await fillFromServerCache(tx.queue.slice(0, 500));
    let sinceRender = 0;
    while (tx.queue.length) {
      const value = tx.queue.shift();
      if (tx.cache.has(value)) { tx.pending.delete(value); continue; }
      try {
        const translated = await translate(value);
        tx.cache.set(value, translated.text);
        tx.failed.delete(value);
        if (translated.provider === "browser-translator") saveToServer(value, translated.text, translated.provider);
      } catch (error) {
        tx.failed.set(value, error.message || String(error));
        tx.message = error.message || String(error);
      }
      tx.pending.delete(value);
      if (++sinceRender >= 5 || !tx.queue.length) { sinceRender = 0; tx.rerender(); }
    }
  } finally {
    tx.busy = false;
    tx.rerender();
  }
}

async function fillFromServerCache(values) {
  const missing = values.filter((v) => !tx.cache.has(v));
  if (!missing.length) return;
  const hashes = await Promise.all(missing.map(sha256));
  try {
    const response = await fetch("/api/translations/lookup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ hashes, source: SOURCE, target: TARGET }) });
    const found = await response.json();
    missing.forEach((value, i) => { if (found[hashes[i]]) tx.cache.set(value, found[hashes[i]].text); });
  } catch { /* キャッシュが引けなくても翻訳はできる */ }
}

async function translate(value) {
  const translator = await browserTranslator();
  if (translator) return { text: await translateInChunks(translator, value), provider: "browser-translator" };
  if (tx.server) {
    const response = await fetch("/api/translate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ texts: [value], source: SOURCE, target: TARGET }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return { text: data.texts[0], provider: data.provider };
  }
  throw new Error("使える翻訳手段がありません");
}

async function browserTranslator() {
  if (tx.translator) return tx.translator;
  if (!("Translator" in self) || ["unsupported", "unavailable", "no_response"].includes(tx.availability)) return null;
  // ダウンロードが要る場合は長くかかるので、ダウンロードが始まっていれば待ち、始まらずに黙っているときだけ打ち切る。
  let downloading = false;
  const creating = self.Translator.create({
    sourceLanguage: SOURCE, targetLanguage: TARGET,
    monitor(monitor) {
      monitor.addEventListener("downloadprogress", (event) => {
        downloading = true;
        tx.availability = "downloading";
        tx.progress = Math.round((event.loaded ?? 0) * 100);
        tx.rerender();
      });
    },
  });
  const silence = new Promise((_, reject) => {
    const check = () => (downloading ? null : reject(new Error("ブラウザ内蔵翻訳が応答しません")));
    setTimeout(check, 15000);
  });
  try {
    tx.translator = await Promise.race([creating, silence]);
  } catch (error) {
    if (!downloading) tx.availability = "no_response";
    if (tx.server) return null;
    throw error;
  }
  tx.availability = "available";
  tx.message = "";
  return tx.translator;
}

/** 長い思考などは一度に渡すと失敗するので、行のまとまりごとに訳して改行を保ったまま戻す。 */
async function translateInChunks(translator, value) {
  const chunks = [];
  let current = "";
  for (const line of value.split("\n")) {
    if (current && current.length + line.length > 1000) { chunks.push(current); current = ""; }
    current = current ? `${current}\n${line}` : line;
  }
  if (current) chunks.push(current);
  const out = [];
  for (const chunk of chunks) out.push(chunk.trim() ? await translator.translate(chunk) : chunk);
  return out.join("\n");
}

function saveToServer(source, text, provider) {
  fetch("/api/translations", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ rows: [{ source, text, provider }], source: SOURCE, target: TARGET }),
  }).catch(() => {});
}

async function sha256(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
