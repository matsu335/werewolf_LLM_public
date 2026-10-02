import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";

const json = (value) => JSON.stringify(value);
const parse = (value) => value == null ? null : JSON.parse(value);

export class Repository {
  constructor(filename = path.resolve("data/werewolf.sqlite")) {
    mkdirSync(path.dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
    this.migrate();
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS games (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL, day INTEGER NOT NULL,
        phase TEXT NOT NULL, winner TEXT, config_json TEXT NOT NULL, snapshot_json TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS game_events (
        game_id TEXT NOT NULL, event_id INTEGER NOT NULL, timestamp TEXT NOT NULL, day INTEGER NOT NULL,
        phase TEXT NOT NULL, type TEXT NOT NULL, visibility TEXT NOT NULL, payload_json TEXT NOT NULL,
        PRIMARY KEY(game_id, event_id), FOREIGN KEY(game_id) REFERENCES games(id)
      );
      CREATE TABLE IF NOT EXISTS llm_calls (
        id TEXT PRIMARY KEY, game_id TEXT NOT NULL, player_id TEXT NOT NULL, day INTEGER NOT NULL,
        phase TEXT NOT NULL, call_type TEXT NOT NULL, success INTEGER NOT NULL, fallback INTEGER NOT NULL,
        timestamp TEXT NOT NULL, log_json TEXT NOT NULL, FOREIGN KEY(game_id) REFERENCES games(id)
      );
      CREATE TABLE IF NOT EXISTS state_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT, game_id TEXT NOT NULL, player_id TEXT NOT NULL,
        state_type TEXT NOT NULL, day INTEGER NOT NULL, phase TEXT NOT NULL, timestamp TEXT NOT NULL,
        state_json TEXT NOT NULL, FOREIGN KEY(game_id) REFERENCES games(id)
      );
      CREATE TABLE IF NOT EXISTS saved_configs (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, config_json TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_events_game ON game_events(game_id, event_id);
      CREATE INDEX IF NOT EXISTS idx_calls_game ON llm_calls(game_id, timestamp);
      CREATE INDEX IF NOT EXISTS idx_state_game ON state_history(game_id, player_id, state_type);
      -- 観察用の日本語訳のキャッシュ。ゲーム状態やLLMへの入力からは一切参照しない。
      CREATE TABLE IF NOT EXISTS translations (
        hash TEXT NOT NULL, source_lang TEXT NOT NULL, target_lang TEXT NOT NULL,
        provider TEXT NOT NULL, text TEXT NOT NULL, created_at TEXT NOT NULL,
        PRIMARY KEY(hash, source_lang, target_lang)
      );
    `);
  }

  saveGame(engine) {
    const snapshot = engine.snapshot();
    const now = new Date().toISOString();
    const existing = this.db.prepare("SELECT created_at FROM games WHERE id=?").get(engine.gameId);
    this.db.prepare(`INSERT OR REPLACE INTO games
      (id,name,status,day,phase,winner,config_json,snapshot_json,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).run(
        engine.gameId, engine.config.name || engine.gameId, engine.state.status, engine.state.day,
        engine.state.phase, engine.state.winner, json(engine.config), json(snapshot), existing?.created_at || now, now,
      );
    const insertEvent = this.db.prepare(`INSERT OR IGNORE INTO game_events
      (game_id,event_id,timestamp,day,phase,type,visibility,payload_json) VALUES(?,?,?,?,?,?,?,?)`);
    for (const event of engine.events) insertEvent.run(event.gameId, event.id, event.timestamp, event.day, event.phase, event.type, event.visibility, json(event.payload));
  }

  getGame(id) {
    const row = this.db.prepare("SELECT snapshot_json FROM games WHERE id=?").get(id);
    return row ? parse(row.snapshot_json) : null;
  }

  listGames() {
    return this.db.prepare("SELECT id,name,status,day,phase,winner,created_at,updated_at FROM games ORDER BY updated_at DESC").all();
  }

  saveLlmCall(log) {
    this.db.prepare(`INSERT OR REPLACE INTO llm_calls
      (id,game_id,player_id,day,phase,call_type,success,fallback,timestamp,log_json) VALUES(?,?,?,?,?,?,?,?,?,?)`)
      .run(log.id, log.gameId, log.playerId, log.day, log.phase, log.callType, Number(log.success), Number(log.fallback), log.timestamp, json(log));
  }

  saveState(gameId, playerId, stateType, day, phase, state) {
    this.db.prepare(`INSERT INTO state_history(game_id,player_id,state_type,day,phase,timestamp,state_json) VALUES(?,?,?,?,?,?,?)`)
      .run(gameId, playerId, stateType, day, phase, new Date().toISOString(), json(state));
  }

  saveConfig(id, name, config) {
    this.db.prepare("INSERT OR REPLACE INTO saved_configs(id,name,config_json,updated_at) VALUES(?,?,?,?)")
      .run(id, name, json(config), new Date().toISOString());
  }

  listConfigs() { return this.db.prepare("SELECT id,name,config_json,updated_at FROM saved_configs ORDER BY updated_at DESC").all().map((r) => ({ ...r, config: parse(r.config_json) })); }

  fullExport(gameId) {
    const game = this.db.prepare("SELECT * FROM games WHERE id=?").get(gameId);
    if (!game) return null;
    const events = this.db.prepare("SELECT * FROM game_events WHERE game_id=? ORDER BY event_id").all(gameId).map((r) => ({ ...r, payload: parse(r.payload_json) }));
    const llmCalls = this.db.prepare("SELECT log_json FROM llm_calls WHERE game_id=? ORDER BY timestamp").all(gameId).map((r) => parse(r.log_json));
    const states = this.db.prepare("SELECT * FROM state_history WHERE game_id=? ORDER BY id").all(gameId).map((r) => ({ ...r, state: parse(r.state_json) }));
    return { game: { ...game, config: parse(game.config_json), snapshot: parse(game.snapshot_json) }, events, llmCalls, stateHistory: states };
  }

  /**
   * 実験の健全性を数字で見るための集計。
   * 「JSONが返るか」「入出力が切り捨てられていないか」「秘密情報が漏れていないか」を
   * 主観ではなく率で確認できるようにする。
   */
  metrics(gameId) {
    const snapshot = this.getGame(gameId);
    if (!snapshot) return null;
    const calls = this.db.prepare("SELECT log_json FROM llm_calls WHERE game_id=? ORDER BY timestamp").all(gameId).map((r) => parse(r.log_json));
    const events = this.db.prepare("SELECT type, visibility, payload_json FROM game_events WHERE game_id=? ORDER BY event_id").all(gameId)
      .map((r) => ({ type: r.type, visibility: r.visibility, payload: parse(r.payload_json) }));
    const trueRoles = Object.fromEntries(Object.values(snapshot.state.players).map((p) => [p.id, p.role]));
    const byCallType = {};
    for (const call of calls) {
      const bucket = byCallType[call.callType] ||= { attempts: 0, failures: 0, fallbacks: 0, outputTruncated: 0, thinkingOnly: 0, inputTruncationSuspected: 0 };
      bucket.attempts += 1;
      if (!call.success && !call.fallback) bucket.failures += 1;
      if (call.fallback) bucket.fallbacks += 1;
      if (call.diagnostics?.outputTruncated) bucket.outputTruncated += 1;
      if (call.diagnostics?.outputTruncated && call.diagnostics?.emptyContent) bucket.thinkingOnly += 1;
      if (call.diagnostics?.truncationSuspected) bucket.inputTruncationSuspected += 1;
    }
    const attempts = calls.length;
    const speeches = events.filter((e) => e.type === "speech");
    const publicEvents = events.filter((e) => e.visibility === "public");
    const coEvents = events.filter((e) => e.type === "co");
    const trueRoleCos = coEvents.filter((e) => e.payload?.claimedRole && e.payload.claimedRole === trueRoles[e.payload.playerId]);
    const wolfCos = coEvents.filter((e) => e.payload?.claimedRole === "werewolf" && trueRoles[e.payload.playerId] === "werewolf");
    const coTargets = new Set(coEvents.filter((e) => e.payload?.after).map((e) => e.payload.playerId));
    const executions = events.filter((e) => e.type === "execution");
    return {
      gameId,
      calls: {
        attempts,
        failedAttempts: calls.filter((c) => !c.success && !c.fallback).length,
        fallbacks: calls.filter((c) => c.fallback).length,
        jsonSuccessRate: attempts ? round(calls.filter((c) => c.success).length / attempts) : null,
        outputTruncatedRate: attempts ? round(calls.filter((c) => c.diagnostics?.outputTruncated).length / attempts) : null,
        // 思考だけで出力枠を使い切ってJSONが1文字も出なかった割合。思考枠の設定が足りているかの判断材料。
        thinkingOnlyRate: attempts ? round(calls.filter((c) => c.diagnostics?.outputTruncated && c.diagnostics?.emptyContent).length / attempts) : null,
        maxReasoningChars: calls.reduce((max, c) => Math.max(max, c.diagnostics?.reasoningChars ?? 0), 0),
        inputTruncationSuspectedRate: attempts ? round(calls.filter((c) => c.diagnostics?.truncationSuspected).length / attempts) : null,
        // 必要量がコンテキスト長の8割を超えた呼び出しの割合。入力は日を追うごとに増えるので、止まる前の予兆として見る。
        contextNearLimitRate: attempts ? round(calls.filter((c) => c.diagnostics?.contextNearLimit).length / attempts) : null,
        maxEstimatedPromptTokens: calls.reduce((max, c) => Math.max(max, c.diagnostics?.estimatedPromptTokens ?? 0), 0),
        maxReportedPromptTokens: calls.reduce((max, c) => Math.max(max, c.diagnostics?.reportedPromptTokens ?? 0), 0),
        maxPromptChars: calls.reduce((max, c) => Math.max(max, c.diagnostics?.promptChars ?? 0), 0),
        byCallType,
      },
      leakage: {
        systemEventsInPublicView: publicEvents.filter((e) => e.type === "llm_status").length,
        coEventsCarryingUnappliedRole: coEvents.filter((e) => e.payload?.type === "none" && e.payload?.claimedRole).length,
        emptySpeeches: speeches.filter((e) => !String(e.payload?.speech || "").trim()).length,
        speechCount: speeches.length,
      },
      co: {
        total: coEvents.length,
        matchingTrueRole: trueRoleCos.length,
        werewolfSelfCo: wolfCos.length,
        executedAfterCo: executions.filter((e) => coTargets.has(e.payload?.playerId)).length,
      },
    };
  }

  getLlmCall(gameId, callId) {
    const row = this.db.prepare("SELECT log_json FROM llm_calls WHERE game_id=? AND id=?").get(gameId, callId);
    return row ? parse(row.log_json) : null;
  }

  getTranslations(hashes, sourceLang, targetLang) {
    const select = this.db.prepare("SELECT hash, text, provider FROM translations WHERE hash=? AND source_lang=? AND target_lang=?");
    const found = {};
    for (const hash of hashes) {
      const row = select.get(hash, sourceLang, targetLang);
      if (row) found[hash] = { text: row.text, provider: row.provider };
    }
    return found;
  }

  saveTranslations(rows, sourceLang, targetLang) {
    const insert = this.db.prepare(`INSERT OR REPLACE INTO translations(hash,source_lang,target_lang,provider,text,created_at) VALUES(?,?,?,?,?,?)`);
    const now = new Date().toISOString();
    for (const row of rows) insert.run(row.hash, sourceLang, targetLang, String(row.provider || "unknown"), String(row.text ?? ""), now);
  }

  deleteGame(gameId) {
    if (!this.db.prepare("SELECT id FROM games WHERE id=?").get(gameId)) return false;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("DELETE FROM state_history WHERE game_id=?").run(gameId);
      this.db.prepare("DELETE FROM llm_calls WHERE game_id=?").run(gameId);
      this.db.prepare("DELETE FROM game_events WHERE game_id=?").run(gameId);
      this.db.prepare("DELETE FROM games WHERE id=?").run(gameId);
      this.db.exec("COMMIT");
      return true;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  close() { this.db.close(); }
}

function round(value) { return Math.round(value * 1000) / 1000; }
