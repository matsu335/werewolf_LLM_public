import { CLAIM_TYPE_IDS, CLAIM_TYPES, CO_TYPES, CONTROLLERS, PHASES, ROLE_IDS, ROLES } from "../domain/constants.js";
import { gameLanguage } from "../domain/config.js";
import { mentionsPartnership, normalizeRoleId, redactUnbackedRoleClaims, splitSentences, unbackedRoleClaims, violatesLanguage } from "../domain/text-rules.js";
import { GameRuleError } from "../domain/game-engine.js";
import { ContextOverflowError } from "../llm/runner.js";
import { text } from "../llm/messages.js";

const clone = (value) => structuredClone(value);
// Humanへ返す却下理由はGUIの言語で出す。発言の言語検査そのものは試合の言語に従う。
const HUMAN_MESSAGE_LANGUAGE = "ja";

export class GameSession {
  constructor({ engine, repository, llmRunner, notify = () => {} }) {
    this.engine = engine;
    this.repository = repository;
    this.llmRunner = llmRunner;
    this.notify = notify;
    this.language = gameLanguage(engine.config);
    this.collection = null;
    this.driving = false;
    this.meeting = null;
    this.pauseRequested = false;
    this.paused = false;
    this.resumeContinuation = null;
    this.pauseWaiters = [];
    this.forceTerminated = false;
  }

  async start() {
    this.engine.start();
    this.persist();
    if (this.engine.state.status === "finished") return;
    try {
      await this.enterInitialSequence();
    } catch (error) {
      if (!(error instanceof SessionStoppedError)) throw error;
    }
  }

  schedule(fn) {
    queueMicrotask(() => fn.call(this).catch((error) => this.fail(error)));
  }

  async enterInitialSequence() {
    if (this.checkpoint(() => this.enterInitialSequence())) return;
    await this.meetOrSkip("initial");
  }

  /** 人狼会議は狼2人以上のときだけ開く。開かない場面では、前回の会議の内容を今回のものとして扱わない。 */
  async meetOrSkip(purpose) {
    if (this.livingWolves().length > 1) return this.runWolfMeeting(purpose);
    this.meeting = null;
    return this.afterWolfMeeting(purpose);
  }

  async afterWolfMeeting(purpose) {
    if (this.checkpoint(() => this.afterWolfMeeting(purpose))) return;
    if (this.engine.state.status === "finished") return this.persist();
    // 作戦メモは会議の要約。会議が開かれていないのに要約を求めると、盤面も配役も持たないモデルが
    // ルールブックの役職一覧から計画を捏造し（狂人のいない卓で「狂人を襲撃する」）、それが以降の入力に載り続けた。
    if (this.meetingHeld(purpose)) await this.updateWolfStrategies(purpose);
    if (purpose === "initial") {
      if (this.engine.config.initialCoPhase) await this.runCoPhase(PHASES.INITIAL_CO);
      else await this.startDiscussion();
    } else if (purpose === "night") await this.runNightActions();
    else if (purpose === "morning") await this.runCoPhase(PHASES.MORNING_CO);
  }

  meetingHeld(purpose) {
    return this.meeting?.purpose === purpose && this.meeting.messages.some((m) => String(m.message || "").trim());
  }

  async runCoPhase(phase) {
    if (this.checkpoint(() => this.runCoPhase(phase))) return;
    const participants = this.engine.livingIds();
    this.engine.setPhase(phase);
    const snapshot = this.basePublicSnapshot();
    await this.collectSimultaneous({
      kind: "co", participants, callType: "co",
      inputFor: (id) => this.aiInput(id, { publicSnapshot: snapshot }),
      validate: (value, id) => validateCo(value, this.engine.player(id).currentCo, this.language), fallback: () => ({ type: "none", role: null }),
      finalize: async (received) => {
        for (const id of participants) this.engine.applyCo(id, received[id]);
        await this.startDiscussion();
      },
    });
  }

  async startDiscussion() {
    if (this.checkpoint(() => this.startDiscussion())) return;
    if (this.engine.state.status === "finished") return this.persist();
    if (!this.engine.state.discussionOrder.length || this.engine.state.round == null) this.engine.createDiscussionOrder();
    await this.runDiscussionRound(1, 0);
  }

  async runDiscussionRound(round, index) {
    if (this.checkpoint(() => this.runDiscussionRound(round, index))) return;
    const order = this.engine.state.discussionOrder.filter((id) => this.engine.player(id).alive);
    if (this.engine.config.discussionMode === "simultaneous") return this.runSimultaneousRound(round, order);
    if (index >= order.length) {
      if (this.engine.state.day === 1 && round === 1) return this.runDiscussionRound(2, 0);
      return this.runVotePhase();
    }
    const id = order[index];
    this.engine.setPhase(PHASES.DISCUSSION, { round, currentActor: id });
    const player = this.playerDescriptor(id);
    if (player.controller === CONTROLLERS.HUMAN) {
      this.waitForHuman("speech", [id], { round, index, prompt: "公開発言とClaimを入力してください（役職の主張はCO操作で行います）" }, async (received) => {
        this.engine.recordSpeech(id, received[id]);
        await this.runDiscussionRound(round, index + 1);
      });
      return;
    }
    const input = this.aiInput(id);
    const context = this.speechContext(id);
    const validate = (value) => validateDiscussion(value, context);
    const fallback = (_error, attempts) => salvageSpeech(attempts?.lastParsed, context);
    const [{ value }] = await this.runSpecs([this.spec(id, "discussion", input, validate, fallback)]);
    this.engine.recordSpeech(id, { speech: value.speech, claims: value.claims });
    this.persist();
    await this.runDiscussionRound(round, index + 1);
  }

  /**
   * 全員が同じスナップショットから同時に発言する方式。直前の発言を読めないため、
   * 逐次方式で観測される「前の話者への追従」を切り離して比較できる。
   */
  async runSimultaneousRound(round, order) {
    if (this.checkpoint(() => this.runSimultaneousRound(round, order))) return;
    this.engine.setPhase(PHASES.DISCUSSION, { round, currentActor: null });
    const snapshot = this.basePublicSnapshot();
    await this.collectSimultaneous({
      kind: "speech", participants: order, callType: "discussion",
      inputFor: (id) => this.aiInput(id, { publicSnapshot: snapshot, task: { simultaneous: true } }),
      validate: (value, id) => validateDiscussion(value, this.speechContext(id)),
      fallback: (_error, id, attempts) => salvageSpeech(attempts?.lastParsed, this.speechContext(id)),
      finalize: async (received) => {
        for (const id of order) {
          this.engine.setPhase(PHASES.DISCUSSION, { round, currentActor: id });
          this.engine.recordSpeech(id, received[id]);
        }
        this.persist();
        if (this.engine.state.day === 1 && round === 1) return this.runSimultaneousRound(2, order.filter((id) => this.engine.player(id).alive));
        return this.runVotePhase();
      },
    });
  }

  /** 公開発言の検査に必要な自分の秘密情報。ルール上の「秘密情報を漏らさない」を機械的に強制する。 */
  speechContext(id, messageLanguage = this.language) {
    const player = this.engine.player(id);
    return {
      role: player.role, partners: [...player.privateInfo.wolfPartners], validTargets: this.engine.state.seatOrder,
      currentCo: player.currentCo, language: this.language, messageLanguage,
    };
  }

  async runVotePhase() {
    if (this.checkpoint(() => this.runVotePhase())) return;
    const participants = this.engine.livingIds();
    this.engine.setPhase(PHASES.VOTE, { round: null, currentActor: null });
    const snapshot = this.basePublicSnapshot();
    await this.collectSimultaneous({
      kind: "vote", participants, callType: "vote",
      inputFor: (id) => this.aiInput(id, { publicSnapshot: snapshot, task: { validTargets: participants } }),
      validate: (value) => validateTarget(value, participants, TARGET_KEYS.vote, this.language),
      fallback: () => ({ target: this.engine.rng.pick(participants) }),
      finalize: async (received) => {
        for (const id of participants) this.engine.submitVote(id, received[id].target);
        this.engine.resolveVotes();
        this.persist();
        if (this.engine.state.status === "finished") return;
        await this.afterVote();
      },
    });
  }

  async afterVote() {
    if (this.checkpoint(() => this.afterVote())) return;
    await this.meetOrSkip("night");
  }

  async afterNight() {
    if (this.checkpoint(() => this.afterNight())) return;
    await this.meetOrSkip("morning");
  }

  async runWolfMeeting(purpose) {
    if (this.checkpoint(() => this.runWolfMeeting(purpose))) return;
    const wolves = this.livingWolves();
    const phase = purpose === "morning" ? PHASES.MORNING_WOLF_MEETING : purpose === "night" ? PHASES.NIGHT_WOLF_MEETING : PHASES.INITIAL_WOLF_MEETING;
    this.engine.setPhase(phase);
    const order = this.engine.rng.shuffle(wolves);
    this.meeting = { purpose, phase, order, messages: [] };
    if (this.engine.config.wolfMeetingMode === "sequential") await this.runSequentialMeeting(0);
    else {
      const base = this.basePublicSnapshot();
      await this.collectSimultaneous({
        kind: "wolf_meeting", participants: wolves, callType: "wolf_meeting",
        inputFor: (id) => this.aiInput(id, { publicSnapshot: base, task: { meeting: { purpose, messages: [] } } }),
        validate: (value) => validateMeeting(value, this.language), fallback: () => ({ message: "" }),
        finalize: async (received) => {
          for (const id of order) this.recordMeetingMessage(id, received[id].message, purpose);
          await this.afterWolfMeeting(purpose);
        },
      });
    }
  }

  async runSequentialMeeting(index) {
    if (this.checkpoint(() => this.runSequentialMeeting(index))) return;
    if (index >= this.meeting.order.length) return this.afterWolfMeeting(this.meeting.purpose);
    const id = this.meeting.order[index];
    const player = this.playerDescriptor(id);
    if (player.controller === CONTROLLERS.HUMAN) {
      this.waitForHuman("wolf_meeting", [id], { purpose: this.meeting.purpose, messages: clone(this.meeting.messages) }, async (received) => {
        this.recordMeetingMessage(id, received[id].message, this.meeting.purpose);
        await this.runSequentialMeeting(index + 1);
      });
      return;
    }
    const input = this.aiInput(id, { task: { meeting: this.meetingForInput() } });
    const [{ value }] = await this.runSpecs([this.spec(id, "wolf_meeting", input, (v) => validateMeeting(v, this.language), () => ({ message: "" }))]);
    this.recordMeetingMessage(id, value.message, this.meeting.purpose);
    await this.runSequentialMeeting(index + 1);
  }

  meetingForInput() {
    return { purpose: this.meeting.purpose, messages: this.meeting.messages.map(({ playerId, message }) => ({ playerId, message })) };
  }

  recordMeetingMessage(playerId, message, purpose) {
    const item = { playerId, message: String(message || "").slice(0, 2000), purpose, day: this.engine.state.day };
    this.meeting.messages.push(item);
    this.engine.emit("wolf_meeting_message", item, "secret");
    this.persist();
  }

  async updateWolfStrategies(purpose) {
    if (this.checkpoint(() => this.updateWolfStrategies(purpose))) return;
    const wolves = this.livingWolves().filter((id) => this.playerDescriptor(id).controller === CONTROLLERS.AI);
    if (!wolves.length) return;
    const meeting = this.meetingForInput();
    // 要約の材料は会議の発言だけでなく盤面と自分の情報も渡す。会議ログだけでは「担当」や「投票方針」を書く根拠が入力に無い。
    const specs = wolves.map((id) => this.spec(id, "strategy_memory", this.aiInput(id, { task: { meeting } }),
      (value) => ({ memory: String(value.memory || value.strategy || "").slice(0, 4000) }), () => ({ memory: this.engine.player(id).wolfStrategyMemory })));
    const results = await this.runSpecs(specs);
    wolves.forEach((id, i) => {
      this.engine.player(id).wolfStrategyMemory = results[i].value.memory;
      this.repository.saveState(this.engine.gameId, id, "wolf_strategy", this.engine.state.day, this.engine.state.phase, results[i].value.memory);
    });
    this.persist();
  }

  async runNightActions() {
    if (this.checkpoint(() => this.runNightActions())) return;
    this.engine.setPhase(PHASES.NIGHT_ACTIONS);
    const actors = this.engine.alivePlayers().filter((p) => [ROLES.WEREWOLF, ROLES.SEER, ROLES.BODYGUARD].includes(p.role)).map((p) => p.id);
    const snapshot = this.basePublicSnapshot();
    const meeting = this.meeting?.purpose === "night" ? this.meetingForInput() : null;
    await this.collectSimultaneous({
      kind: "night_action", participants: actors,
      callTypeFor: (id) => this.nightCallType(id),
      inputFor: (id) => this.aiInput(id, {
        publicSnapshot: snapshot,
        task: { validTargets: this.validNightTargets(id), ...(meeting && this.engine.player(id).role === ROLES.WEREWOLF ? { meeting } : {}) },
      }),
      validate: (value, id) => validateTarget(value, this.validNightTargets(id), TARGET_KEYS[this.nightCallType(id)], this.language),
      fallback: (_error, id) => ({ target: this.engine.rng.pick(this.validNightTargets(id)) }),
      finalize: async (received) => {
        for (const id of actors) {
          const role = this.engine.player(id).role;
          if (role === ROLES.WEREWOLF) this.engine.submitAttackVote(id, received[id].target);
          if (role === ROLES.SEER) this.engine.submitDivination(id, received[id].target);
          if (role === ROLES.BODYGUARD) this.engine.submitGuard(id, received[id].target);
        }
        this.engine.resolveNight();
        this.persist();
        if (this.engine.state.status === "finished") return;
        await this.afterNight();
      },
    });
  }

  /** 夜行動の呼び出し種別。役職ごとに指示文も出力キーも別なので、役職から一意に決める。 */
  nightCallType(id) {
    return { [ROLES.WEREWOLF]: "attack", [ROLES.SEER]: "divination", [ROLES.BODYGUARD]: "guard" }[this.engine.player(id).role];
  }

  validNightTargets(id) {
    const p = this.engine.player(id);
    if (p.role === ROLES.WEREWOLF) return this.engine.alivePlayers().filter((x) => x.role !== ROLES.WEREWOLF).map((x) => x.id);
    if (p.role === ROLES.SEER) return this.engine.livingIds().filter((x) => x !== id);
    if (p.role === ROLES.BODYGUARD) {
      const previous = [...p.privateInfo.guards].reverse().find((g) => g.day === this.engine.state.day - 1)?.target;
      return this.engine.livingIds().filter((x) => x !== id && x !== previous);
    }
    return [];
  }

  async collectSimultaneous({ kind, participants, callType, callTypeFor, inputFor, validate, fallback, finalize }) {
    const received = {};
    const ai = participants.filter((id) => this.playerDescriptor(id).controller === CONTROLLERS.AI);
    const humans = participants.filter((id) => this.playerDescriptor(id).controller === CONTROLLERS.HUMAN);
    const specs = ai.map((id) => this.spec(id, callTypeFor ? callTypeFor(id) : callType, inputFor(id), (value) => validate(value, id), (error, attempts) => fallback(error, id, attempts)));
    const results = await this.runSpecs(specs);
    ai.forEach((id, i) => { received[id] = results[i].value; });
    if (humans.length) {
      this.collection = { kind, participants, received, validate, finalize };
      this.waitForHuman(kind, humans, { prompt: humanPrompt(kind) }, async (humanReceived) => {
        Object.assign(received, humanReceived);
        await finalize(received);
      });
      return;
    }
    await finalize(received);
  }

  waitForHuman(kind, required, context, onComplete) {
    if (!this.collection || this.collection.kind !== kind) this.collection = { kind, participants: required, received: {}, validate: (v) => v, finalize: onComplete };
    else this.collection.finalize = onComplete;
    this.engine.state.pending = { kind, required: [...required], completed: [], context };
    this.persist();
  }

  async submitHumanAction(playerId, kind, value) {
    if (this.paused || this.pauseRequested) throw new GameRuleError("ゲームは一時停止中です", "GAME_PAUSED");
    const pending = this.engine.state.pending;
    if (!pending || pending.kind !== kind || !pending.required.includes(playerId)) throw new GameRuleError("現在この操作は要求されていません", "UNEXPECTED_HUMAN_ACTION");
    if (this.playerDescriptor(playerId).controller !== CONTROLLERS.HUMAN) throw new GameRuleError("Humanプレイヤーではありません");
    const lang = HUMAN_MESSAGE_LANGUAGE;
    let normalized = value;
    if (kind === "speech") normalized = validateDiscussion(value, this.speechContext(playerId, lang));
    else if (kind === "co") normalized = validateCo(value, this.engine.player(playerId).currentCo, lang);
    else if (kind === "vote") normalized = validateTarget(value, this.engine.livingIds(), TARGET_KEYS.vote, lang);
    else if (kind === "night_action") normalized = validateTarget(value, this.validNightTargets(playerId), TARGET_KEYS[this.nightCallType(playerId)], lang);
    else if (kind === "wolf_meeting") normalized = validateMeeting(value, this.language, lang);
    this.collection.received[playerId] = normalized;
    pending.completed = Object.keys(this.collection.received).filter((id) => pending.required.includes(id));
    this.persist();
    if (pending.required.every((id) => this.collection.received[id] !== undefined)) {
      const collection = this.collection;
      this.collection = null;
      this.engine.state.pending = null;
      await collection.finalize(collection.received);
    }
  }

  spec(id, callType, input, validate, fallback) {
    return {
      gameId: this.engine.gameId, player: this.playerDescriptor(id), callType, language: this.language,
      day: this.engine.state.day, phase: this.engine.state.phase, round: this.engine.state.round,
      input: clone(input), validate, fallback,
      beforeAttempt: () => this.waitForLlmPermission(),
    };
  }

  async runSpecs(specs) {
    if (!specs.length) return [];
    let results;
    try {
      results = await this.llmRunner.batch(specs, this.engine.config.llmExecutionMode);
    } catch (error) {
      if (error instanceof ContextOverflowError) this.halt(error);
      throw error;
    }
    if (this.forceTerminated || this.engine.state.status === "finished") throw new SessionStoppedError();
    return results;
  }

  /**
   * 続行するとモデルの視界が黙って欠ける状態になったので、試合をここで終える。
   * Fallbackで続けると無作為な投票や行動が混ざり、観察対象がモデルの判断ではなくなる。
   */
  halt(error) {
    this.engine.emit("system_error", { message: error.message, kind: error.name, details: error.details ?? null }, "secret");
    this.engine.finish("terminated", error.message);
    this.persist();
    throw new SessionStoppedError();
  }

  requestPause() {
    if (this.engine.state.status !== "running") throw new GameRuleError("進行中のゲームではありません", "GAME_NOT_RUNNING");
    if (this.paused || this.pauseRequested) return;
    if (this.engine.state.pending && this.engine.state.pending.kind !== "system_error") {
      this.paused = true;
      this.engine.state.paused = true;
      this.engine.emit("game_paused", { immediate: true }, "public");
    } else {
      this.pauseRequested = true;
      this.engine.state.pauseRequested = true;
      this.engine.emit("game_pause_requested", { afterCurrentOperation: true }, "public");
    }
    this.persist();
  }

  resume() {
    if (this.engine.state.status !== "running") throw new GameRuleError("進行中のゲームではありません", "GAME_NOT_RUNNING");
    if (this.pauseRequested && !this.paused) {
      this.pauseRequested = false;
      this.engine.state.pauseRequested = false;
      this.engine.emit("game_pause_cancelled", {}, "public");
      return this.persist();
    }
    if (!this.paused) return;
    this.paused = false;
    this.engine.state.paused = false;
    this.engine.state.pauseRequested = false;
    this.engine.emit("game_resumed", {}, "public");
    const continuation = this.resumeContinuation;
    this.resumeContinuation = null;
    const waiters = this.pauseWaiters.splice(0);
    this.persist();
    for (const resolve of waiters) resolve();
    if (continuation) this.schedule(continuation);
  }

  forceTerminate(reason = "ユーザーによる強制終了") {
    if (this.engine.state.status === "finished") return;
    this.forceTerminated = true;
    this.pauseRequested = false;
    this.paused = false;
    this.resumeContinuation = null;
    for (const resolve of this.pauseWaiters.splice(0)) resolve();
    this.collection = null;
    this.engine.state.paused = false;
    this.engine.state.pauseRequested = false;
    this.engine.finish("terminated", reason);
    this.persist();
  }

  checkpoint(continuation) {
    if (this.forceTerminated || this.engine.state.status === "finished") return true;
    if (!this.pauseRequested) return false;
    this.pauseRequested = false;
    this.paused = true;
    this.resumeContinuation = continuation;
    this.engine.state.paused = true;
    this.engine.state.pauseRequested = false;
    this.engine.emit("game_paused", { immediate: false }, "public");
    this.persist();
    return true;
  }

  async waitForLlmPermission() {
    if (this.forceTerminated || this.engine.state.status === "finished") throw new SessionStoppedError();
    if (this.pauseRequested && !this.paused) {
      this.pauseRequested = false;
      this.paused = true;
      this.engine.state.paused = true;
      this.engine.state.pauseRequested = false;
      this.engine.emit("game_paused", { immediate: false, beforeNextLlmCall: true }, "public");
      this.persist();
    }
    if (!this.paused) return;
    await new Promise((resolve) => this.pauseWaiters.push(resolve));
    if (this.forceTerminated || this.engine.state.status === "finished") throw new SessionStoppedError();
  }

  playerDescriptor(id) {
    const config = this.engine.config.players.find((p) => p.id === id);
    return { ...clone(config), ...clone(this.engine.player(id)) };
  }

  /** 自分だけが知る情報。privateInfo（占い結果・護衛履歴・仲間・投票履歴）はエンジンが書く事実で、モデルには書き換えさせない。 */
  privateSelf(id) {
    const p = this.engine.player(id);
    return { id: p.id, role: p.role, privateInfo: clone(p.privateInfo), wolfStrategyMemory: p.wolfStrategyMemory };
  }

  /**
   * LLMへ渡す公開情報。生イベント列（llm_statusなどの運用ログを含む）ではなく
   * 正規化した盤面を渡す。publicView()はUI専用なのでここでは使わない。
   */
  basePublicSnapshot() {
    return this.engine.publicBrief();
  }

  aiInput(id, { publicSnapshot = this.basePublicSnapshot(), task = {} } = {}) {
    return { publicState: publicSnapshot, self: this.privateSelf(id), task };
  }

  livingWolves() { return this.engine.alivePlayers().filter((p) => p.role === ROLES.WEREWOLF).map((p) => p.id); }

  persist() {
    this.repository.saveGame(this.engine);
    this.notify(this.engine.gameId, { type: "state", state: this.engine.publicView() });
  }

  fail(error) {
    if (error instanceof SessionStoppedError) return;
    this.engine.emit("system_error", { message: error.message, stack: error.stack }, "secret");
    this.engine.state.pending = { kind: "system_error", required: [], completed: [], context: { message: error.message } };
    this.persist();
  }
}

class SessionStoppedError extends Error {}

function validateCo(value, currentCo = null, lang = "ja") {
  const t = text(lang);
  const source = value?.co_action || value?.coAction || value;
  const type = normalizeCoType(source?.type ?? source?.action ?? source?.decision);
  const role = normalizeRoleId(source?.claimed_role ?? source?.claimedRole ?? source?.role ?? null);
  if (!CO_TYPES.includes(type)) throw new Error(t.coTypeInvalid(source?.type));
  if (type === "change" && !currentCo) {
    if (!ROLE_IDS.includes(role)) throw new Error(t.coRoleInvalid);
    return { type: "declare", role };
  }
  if (["declare", "change"].includes(type) && !ROLE_IDS.includes(role)) throw new Error(t.coRoleInvalid);
  return { type, role: ["declare", "change"].includes(type) ? role : null };
}

/**
 * 公開発言の検査。内容をまるごと捨てると「発言なし」という偽の推理材料が生まれるため、
 * 秘密情報の混入だけを文単位で落とし、言語違反は差し戻して再生成させる。
 */
function validateDiscussion(value, context = null) {
  const language = context?.language ?? "ja";
  const t = text(context?.messageLanguage ?? language);
  if (!value || typeof value !== "object") throw new Error(t.speechNotObject);
  const raw = String(value.speech ?? value.message ?? "").slice(0, 4000);
  if (!raw.trim()) throw new Error(t.speechEmpty);
  // 内容ではなく言語だけを直させる。書き直しを求めると論拠が落ちた一行に縮むため、翻訳として扱う。
  if (violatesLanguage(raw, language)) throw new Error(t.speechLanguage);
  const unbacked = context ? unbackedRoleClaims(raw, language, context.currentCo ?? null) : [];
  if (unbacked.length) throw new Error(t.unbackedClaim(unbacked.join(", "), context.currentCo ?? null));
  const leaks = detectPartnerLeaks(raw, context);
  if (leaks.length) throw new Error(t.speechLeak(t.partnerReveal));
  const claims = normalizeClaims(value.claims, context);
  const untethered = findUntetheredClaims(raw, claims);
  if (untethered.length) throw new Error(t.untethered(untethered.join(" / ")));
  return { speech: raw.trim(), claims };
}

/**
 * 発言本文に現れない占い結果・護衛のclaim。
 * claimsは全員に公開されるため、本文で何も言わずにclaimだけ立てると、誰も反応できない
 * 裏口で情報が配られる。どの陣営でも偽のclaimは自由に出せるので、これは嘘を封じる検査ではなく
 * 「主張は公開の場で述べる」というルールの検査である。
 */
function findUntetheredClaims(speech, claims) {
  const source = String(speech ?? "");
  return claims
    .filter((claim) => [CLAIM_TYPES.DIVINATION_RESULT, CLAIM_TYPES.GUARD].includes(claim.type))
    .filter((claim) => claim.target && !new RegExp(`${claim.target}\\b`, "u").test(source))
    .map((claim) => `${claim.type} → ${claim.target}`);
}

/** 検査を通らなかった発言の最終処理。COの裏付けがない名乗りと仲間の暴露だけを削って残りを活かす。 */
function salvageSpeech(value, context = null) {
  const language = context?.language ?? "ja";
  const raw = String(value?.speech ?? value?.message ?? "");
  const { text: kept } = redactUnbackedRoleClaims(stripPartnerMentions(raw, context), language, context?.currentCo ?? null);
  const speech = kept.trim() || text(language).fallbackSpeech;
  const claims = normalizeClaims(value?.claims, context);
  // ここで残すと、差し戻しても最後はclaimの裏口から情報が配られることになる。
  const untethered = new Set(findUntetheredClaims(speech, claims));
  return { speech, claims: claims.filter((claim) => !untethered.has(`${claim.type} → ${claim.target}`)) };
}

function detectPartnerLeaks(speech, context) {
  if (!context?.partners?.length) return [];
  const language = context.language ?? "ja";
  return splitSentences(speech, language)
    .filter((sentence) => context.partners.some((id) => new RegExp(`${id}\\b`, "u").test(sentence)) && mentionsPartnership(sentence, language));
}

function stripPartnerMentions(speech, context) {
  if (!context?.partners?.length) return speech;
  const language = context.language ?? "ja";
  const leaks = new Set(detectPartnerLeaks(speech, context));
  return splitSentences(speech, language).filter((sentence) => !leaks.has(sentence)).join(language === "en" ? " " : "");
}

function normalizeClaims(claims, context = null) {
  if (!Array.isArray(claims)) return [];
  const valid = new Set(context?.validTargets || []);
  return claims.slice(0, 4).map((claim) => {
    const type = CLAIM_TYPE_IDS.includes(claim?.type) ? claim.type : CLAIM_TYPES.OTHER;
    const rawTarget = claim?.target ?? claim?.targetId ?? claim?.player ?? null;
    const target = valid.size === 0 || valid.has(rawTarget) ? rawTarget : null;
    const raw = String(claim?.value ?? claim?.claim ?? claim?.result ?? "").slice(0, 120);
    const value = type === CLAIM_TYPES.DIVINATION_RESULT ? normalizeDivinationClaim(raw) : raw;
    return { type, target: target ?? null, value };
  }).filter((claim) => claim.target || claim.value);
}

/**
 * 占い結果の主張を二値に揃える。
 * 「白」「人狼ではない」「not werewolf」が混在すると、同じ主張なのに公開情報の上では
 * 別物に見えてしまい、誰が誰の結果を追認したのかを追えなくなる。真偽は判定しない。
 */
function normalizeDivinationClaim(value) {
  const source = String(value ?? "");
  if (/人狼ではない|人狼じゃない|白|not[_\s-]*(?:a[_\s-]+)?(?:were)?wolf|innocent|村人側|\bhuman\b|\bwhite\b|\bclear(?:ed)?\b/iu.test(source)) return "not_werewolf";
  if (/人狼|黒|werewolf|wolf|\bblack\b/iu.test(source)) return "werewolf";
  return source;
}

/**
 * 対象を1人選ぶ呼び出しで、種別ごとに要求するキー名。
 * 投票も夜行動も同じ {target} を受け取っていたころ、狩人が処刑投票に護衛先を書き込み、
 * 白く見えていた相手に村の票が集まって処刑される事故が起きた。何を選ぶ場面かをキー名で区別する。
 */
const TARGET_KEYS = { vote: "execute_target", attack: "attack_target", divination: "divine_target", guard: "guard_target" };
// プロンプトの例示値。モデルがこれをそのまま写して返したことがある。
const PLACEHOLDER = /^\s*<[^>]*>\s*$/u;

function validateTarget(value, validTargets, key, lang = "ja") {
  const t = text(lang);
  const action = t.actions[key];
  // 他の行動のキーで答えているなら、誰を選ぶかではなく何を選ぶ場面かを取り違えている。
  const confused = Object.keys(t.actions).find((other) => other !== key && value?.[other] != null);
  if (confused) throw new Error(t.sceneConfusion(action, t.actions[confused], key));
  const target = value?.[key] ?? value?.target;
  // 候補を示さずに「含まれていない」とだけ返すと、モデルは候補が入力に無いと推論してしまう。
  if (!validTargets.includes(target)) throw new Error(t.notCandidate(key, target, validTargets.join(", ")));
  const reason = String(value.reason || value.reasoning || "");
  if (PLACEHOLDER.test(reason)) throw new Error(t.placeholder("reason"));
  return { target, reason: reason.slice(0, 600) };
}

function validateMeeting(value, language = "ja", messageLanguage = language) {
  const message = String(value?.message || value?.proposal || value?.speech || "").slice(0, 2000);
  if (message && violatesLanguage(message, language)) throw new Error(text(messageLanguage).meetingLanguage);
  return { message };
}

function humanPrompt(kind) {
  return ({ co: "CO操作を選択してください", speech: "公開発言とClaimを入力してください", vote: "秘密投票先を選択してください", night_action: "夜行動の対象を選択してください", wolf_meeting: "仲間への秘密メッセージを入力してください" })[kind] || "操作してください";
}

function normalizeCoType(value) {
  const key = String(value || "none").trim().toLowerCase().replace(/[ _-]+/g, "");
  if (["none", "noaction", "何もしない", "なし"].includes(key)) return "none";
  if (["declare", "co", "comingout", "宣言"].includes(key)) return "declare";
  if (["withdraw", "retract", "撤回"].includes(key)) return "withdraw";
  if (["change", "変更"].includes(key)) return "change";
  return value;
}

export { validateCo, validateDiscussion, validateMeeting, validateTarget, salvageSpeech, TARGET_KEYS };
