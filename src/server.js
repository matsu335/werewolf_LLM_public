import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createHash } from "node:crypto";
import { defaultConfig, validateConfig } from "./domain/config.js";
import { GameRuleError } from "./domain/game-engine.js";
import { Repository } from "./storage/repository.js";
import { SessionManager } from "./app/session-manager.js";
import { LANGUAGES, ROLE_IDS } from "./domain/constants.js";
import { PromptStore } from "./llm/prompt-store.js";
import { contextPlanErrors, planContext } from "./llm/context-plan.js";
import { credentialErrors } from "./llm/openai-client.js";
import { renderInput } from "./llm/input-renderer.js";
import { translateWithServerProvider, serverTranslationProvider } from "./translation.js";

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "127.0.0.1";
const PUBLIC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public");
const repository = new Repository(process.env.WEREWOLF_DB || path.resolve("data/werewolf.sqlite"));
const sessions = new SessionManager(repository);
const promptStore = new PromptStore();

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
    const parts = url.pathname.split("/").filter(Boolean);
    if (request.method === "GET" && url.pathname === "/api/config/default") return sendJson(response, 200, defaultConfig());
    if (request.method === "POST" && url.pathname === "/api/config/plan") {
      const config = await readJson(request);
      const errors = validateConfig(config);
      if (errors.length) return sendJson(response, 400, { errors });
      return sendJson(response, 200, { plan: planContext(config, promptStore), errors: [...credentialErrors(config), ...contextPlanErrors(config, promptStore)] });
    }
    if (request.method === "GET" && url.pathname === "/api/games") return sendJson(response, 200, repository.listGames());
    if (request.method === "GET" && url.pathname === "/api/configs") return sendJson(response, 200, repository.listConfigs());
    if (request.method === "GET" && parts[0] === "api" && parts[1] === "roles" && ROLE_IDS.includes(parts[2])) {
      const lang = LANGUAGES.includes(url.searchParams.get("lang")) ? url.searchParams.get("lang") : "ja";
      const text = await readFile(path.resolve("config", lang, "roles", `${parts[2]}.md`), "utf8");
      return sendJson(response, 200, { role: parts[2], text });
    }
    if (request.method === "POST" && url.pathname === "/api/configs") {
      const body = await readJson(request);
      const errors = validateConfig(body.config);
      if (errors.length) return sendJson(response, 400, { errors });
      const id = body.id || crypto.randomUUID();
      repository.saveConfig(id, body.name || body.config.name || id, body.config);
      return sendJson(response, 201, { id });
    }
    if (request.method === "POST" && url.pathname === "/api/games") {
      const config = await readJson(request);
      const errors = validateConfig(config);
      if (!errors.length) errors.push(...credentialErrors(config), ...contextPlanErrors(config, promptStore));
      if (errors.length) return sendJson(response, 400, { errors });
      const session = sessions.create(config);
      return sendJson(response, 201, { gameId: session.engine.gameId });
    }
    if (parts[0] === "api" && parts[1] === "games" && parts[2]) {
      const id = parts[2];
      if (request.method === "GET" && parts.length === 3) {
        const view = sessions.getView(id, url.searchParams.get("playerId"));
        return view ? sendJson(response, 200, view) : sendJson(response, 404, { error: "Game not found" });
      }
      if (request.method === "GET" && parts[3] === "events") {
        response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        response.write(`data: ${JSON.stringify({ type: "connected" })}\n\n`);
        sessions.subscribe(id, response);
        return;
      }
      if (request.method === "POST" && parts[3] === "actions") {
        const session = sessions.getSession(id);
        if (!session) return sendJson(response, 409, { error: "終了済みまたは再起動前のゲームは操作できません" });
        const body = await readJson(request);
        await session.submitHumanAction(body.playerId, body.kind, body.value);
        return sendJson(response, 202, { accepted: true });
      }
      if (request.method === "POST" && parts[3] === "pause") {
        const session = sessions.getSession(id);
        if (!session) return sendJson(response, 409, { error: "このゲームは現在のプロセスでは操作できません" });
        session.requestPause();
        return sendJson(response, 202, { accepted: true });
      }
      if (request.method === "POST" && parts[3] === "resume") {
        const session = sessions.getSession(id);
        if (!session) return sendJson(response, 409, { error: "このゲームは現在のプロセスでは操作できません" });
        session.resume();
        return sendJson(response, 202, { accepted: true });
      }
      if (request.method === "POST" && parts[3] === "terminate") {
        const session = sessions.getSession(id);
        if (!session) return sendJson(response, 409, { error: "このゲームは現在のプロセスでは操作できません" });
        session.forceTerminate();
        return sendJson(response, 200, { terminated: true });
      }
      if (request.method === "DELETE" && parts.length === 3) {
        const result = sessions.deleteGame(id);
        if (result.reason === "running") return sendJson(response, 409, { error: "進行中のゲームは、先に強制終了してから削除してください" });
        return result.deleted ? sendJson(response, 200, { deleted: true }) : sendJson(response, 404, { error: "Game not found" });
      }
      if (request.method === "GET" && parts[3] === "calls" && parts[4] && parts[5] === "japanese") {
        const log = repository.getLlmCall(id, parts[4]);
        if (!log) return sendJson(response, 404, { error: "Call not found" });
        return sendJson(response, 200, japaneseParallel(log));
      }
      if (request.method === "GET" && parts[3] === "metrics") {
        const data = repository.metrics(id);
        return data ? sendJson(response, 200, data) : sendJson(response, 404, { error: "Game not found" });
      }
      if (request.method === "GET" && parts[3] === "export") {
        const data = repository.fullExport(id);
        if (!data) return sendJson(response, 404, { error: "Game not found" });
        response.writeHead(200, { "content-type": "application/json; charset=utf-8", "content-disposition": `attachment; filename="werewolf-${id}.json"` });
        return response.end(JSON.stringify(data, null, 2));
      }
    }
    if (request.method === "GET" && url.pathname === "/api/translation/provider") {
      return sendJson(response, 200, { server: serverTranslationProvider() });
    }
    if (request.method === "POST" && url.pathname === "/api/translations/lookup") {
      const body = await readJson(request);
      return sendJson(response, 200, repository.getTranslations((body.hashes || []).slice(0, 2000), body.source || "en", body.target || "ja"));
    }
    if (request.method === "POST" && url.pathname === "/api/translations") {
      const body = await readJson(request);
      const rows = (body.rows || []).filter((row) => row && typeof row.text === "string" && typeof row.source === "string")
        .map((row) => ({ hash: sha256(row.source), text: row.text, provider: row.provider }));
      repository.saveTranslations(rows, body.source || "en", body.target || "ja");
      return sendJson(response, 201, { saved: rows.length });
    }
    if (request.method === "POST" && url.pathname === "/api/translate") {
      const body = await readJson(request);
      const texts = (body.texts || []).map(String).slice(0, 200);
      const translated = await translateWithServerProvider(texts, body.source || "en", body.target || "ja");
      if (!translated) return sendJson(response, 501, { error: "サーバー側の翻訳プロバイダが設定されていません（DEEPL_API_KEY）" });
      repository.saveTranslations(texts.map((source, i) => ({ hash: sha256(source), text: translated.texts[i], provider: translated.provider })), body.source || "en", body.target || "ja");
      return sendJson(response, 200, { provider: translated.provider, texts: translated.texts });
    }
    if (request.method === "POST" && url.pathname === "/api/system/shutdown") {
      sessions.shutdownAll();
      sendJson(response, 200, { shuttingDown: true });
      setTimeout(() => {
        repository.close();
        server.close();
        process.exit(0);
      }, 300);
      return;
    }
    if (request.method !== "GET") return sendJson(response, 404, { error: "Not found" });
    await serveStatic(url.pathname, response);
  } catch (error) {
    const status = error instanceof GameRuleError ? 400 : 500;
    sendJson(response, status, { error: error.message, code: error.code || "INTERNAL_ERROR" });
  }
});

server.listen(PORT, HOST, () => console.log(`Werewolf LLM Lab: http://${HOST}:${PORT}`));
server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`ポート ${PORT} は既に使用中です。既存の画面を開くか、$env:PORT=3001 を指定してください。`);
    process.exitCode = 1;
    return;
  }
  throw error;
});

const sha256 = (value) => createHash("sha256").update(String(value)).digest("hex");

/**
 * 英語で送った呼び出しに対応する日本語版。訳ではなく、同じ構造化入力を日本語のテンプレートと
 * 日本語版のプロンプトファイルで描き直したもの。観察用の副産物で、ゲームやLLMへは一切戻さない。
 */
function japaneseParallel(log) {
  if (!log.request || !log.input || !log.trueRole) return { messages: [] };
  const messages = log.request.body.messages.map((message, index) => {
    if (index === 0) return { role: message.role, content: promptStore.bundle(log.callType, log.trueRole, "ja").system, kind: "parallel" };
    if (index === 1) return { role: message.role, content: renderInput({ ...log.input, task: { ...log.input.task, callType: log.callType } }, "ja"), kind: "parallel" };
    return { role: message.role, content: null, kind: "needs_translation" };
  });
  return { messages };
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 5_000_000) throw new Error("Request body too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function sendJson(response, status, value) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(value));
}

async function serveStatic(pathname, response) {
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\//, "");
  const fullPath = path.resolve(PUBLIC, relative);
  if (!fullPath.startsWith(PUBLIC)) return sendJson(response, 403, { error: "Forbidden" });
  try {
    const body = await readFile(fullPath);
    const ext = path.extname(fullPath);
    const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };
    response.writeHead(200, { "content-type": types[ext] || "application/octet-stream" });
    response.end(body);
  } catch { sendJson(response, 404, { error: "Not found" }); }
}
