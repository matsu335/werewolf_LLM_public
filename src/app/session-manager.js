import { GameEngine } from "../domain/game-engine.js";
import { VISIBILITIES } from "../domain/constants.js";
import { LlmRunner } from "../llm/runner.js";
import { OpenAICompatibleClient } from "../llm/openai-client.js";
import { PromptStore } from "../llm/prompt-store.js";
import { GameSession } from "./game-session.js";

export class SessionManager {
  constructor(repository) {
    this.repository = repository;
    this.sessions = new Map();
    this.listeners = new Map();
  }

  create(config) {
    const engine = new GameEngine(config);
    const runner = new LlmRunner({
      client: new OpenAICompatibleClient(), promptStore: new PromptStore(),
      onLog: (log) => this.repository.saveLlmCall(log),
      onStatus: (status) => {
        // 運用テレメトリはsystem。publicにするとcallTypeから夜の役職行動が全員に漏れる。
        engine.emit("llm_status", status, VISIBILITIES.SYSTEM);
        this.repository.saveGame(engine);
        this.emit(engine.gameId, { type: "llm_status", status });
      },
    });
    const session = new GameSession({ engine, repository: this.repository, llmRunner: runner, notify: (id, data) => this.emit(id, data) });
    this.sessions.set(engine.gameId, session);
    session.schedule(session.start);
    return session;
  }

  getSession(id) { return this.sessions.get(id) || null; }

  deleteGame(id) {
    const session = this.sessions.get(id);
    if (session?.engine.state.status === "running") return { deleted: false, reason: "running" };
    this.sessions.delete(id);
    return { deleted: this.repository.deleteGame(id), reason: null };
  }

  shutdownAll() {
    for (const session of this.sessions.values()) session.forceTerminate("システム終了による強制終了");
    for (const listeners of this.listeners.values()) for (const response of listeners) response.end();
    this.listeners.clear();
  }

  getView(id, playerId = null) {
    const session = this.sessions.get(id);
    if (session) return playerId ? session.engine.privateView(playerId) : session.engine.publicView();
    const snapshot = this.repository.getGame(id);
    if (!snapshot) return null;
    const engine = GameEngine.restore(snapshot);
    return playerId ? engine.privateView(playerId) : engine.publicView();
  }

  subscribe(id, response) {
    if (!this.listeners.has(id)) this.listeners.set(id, new Set());
    this.listeners.get(id).add(response);
    response.on("close", () => this.listeners.get(id)?.delete(response));
  }

  emit(id, data) {
    const payload = `data: ${JSON.stringify(data)}\n\n`;
    for (const response of this.listeners.get(id) || []) response.write(payload);
  }
}
