import { CO_TYPES, PHASES, ROLE_IDS, ROLES, VISIBILITIES, WOLF_TEAM } from "./constants.js";
import { validateConfig } from "./config.js";
import { SeededRandom } from "./rng.js";

const clone = (value) => structuredClone(value);

export class GameRuleError extends Error {
  constructor(message, code = "INVALID_ACTION") {
    super(message);
    this.name = "GameRuleError";
    this.code = code;
  }
}

export class GameEngine {
  constructor(config, { gameId = crypto.randomUUID(), now = () => new Date().toISOString() } = {}) {
    const errors = validateConfig(config);
    if (errors.length) throw new GameRuleError(errors.join(" / "), "INVALID_CONFIG");
    this.config = clone(config);
    this.gameId = gameId;
    this.now = now;
    this.rng = new SeededRandom(config.seed);
    this.events = [];
    this.seq = 0;
    this.state = {
      gameId,
      status: "created",
      paused: false,
      pauseRequested: false,
      day: 0,
      phase: PHASES.SETUP,
      round: null,
      seatOrder: config.players.map((p) => p.id),
      discussionOrder: [],
      currentActor: null,
      players: Object.fromEntries(config.players.map((p, seat) => [p.id, {
        id: p.id,
        name: p.name || p.id,
        seat,
        controller: p.controller,
        role: null,
        alive: true,
        currentCo: null,
        claimHistory: [],
        privateInfo: { divinations: [], guards: [], wolfPartners: [], votes: [], attackVotes: [] },
        wolfStrategyMemory: "",
      }])),
      votes: {},
      attackVotes: {},
      nightActions: { guards: {}, divinations: {}, attackTarget: null },
      publicVoteTallies: [],
      executions: [],
      nightDeaths: [],
      winner: null,
      winningReason: null,
      pending: null,
      rng: this.rng.snapshot(),
    };
  }

  start() {
    if (this.state.status !== "created") throw new GameRuleError("ゲームは既に開始されています");
    const pool = [];
    for (const role of ROLE_IDS) {
      const fixedCount = this.config.players.filter((p) => p.fixedRole === role).length;
      for (let i = 0; i < this.config.roleCounts[role] - fixedCount; i += 1) pool.push(role);
    }
    const shuffled = this.rng.shuffle(pool);
    for (const playerConfig of this.config.players) {
      const player = this.player(playerConfig.id);
      player.role = playerConfig.fixedRole || shuffled.shift();
    }

    const wolves = this.alivePlayers().filter((p) => p.role === ROLES.WEREWOLF).map((p) => p.id);
    for (const wolfId of wolves) this.player(wolfId).privateInfo.wolfPartners = wolves.filter((id) => id !== wolfId);
    for (const seer of this.alivePlayers().filter((p) => p.role === ROLES.SEER)) {
      const candidates = this.alivePlayers().filter((p) => p.id !== seer.id && p.role !== ROLES.WEREWOLF);
      const target = this.rng.pick(candidates);
      if (target) seer.privateInfo.divinations.push({ day: 0, target: target.id, result: "not_werewolf", kind: "initial_random_white" });
    }
    this.state.status = "running";
    this.state.day = 1;
    this.state.rng = this.rng.snapshot();
    this.emit("game_started", {
      seed: this.config.seed,
      seatOrder: this.state.seatOrder,
      promptPolicy: "external_files_with_sha256",
    }, "public");
    for (const p of this.alivePlayers()) this.emit("role_assigned", { playerId: p.id, role: p.role }, "secret");
    this.checkVictory("game_start");
    return this.snapshot();
  }

  player(id) {
    const player = this.state.players[id];
    if (!player) throw new GameRuleError(`存在しないプレイヤーです: ${id}`, "UNKNOWN_PLAYER");
    return player;
  }

  alivePlayers() { return this.state.seatOrder.map((id) => this.state.players[id]).filter((p) => p.alive); }
  livingIds() { return this.alivePlayers().map((p) => p.id); }

  setPhase(phase, { round = null, currentActor = null, pending = null } = {}) {
    if (this.state.status === "finished" && phase !== PHASES.FINISHED) return;
    this.state.phase = phase;
    this.state.round = round;
    this.state.currentActor = currentActor;
    this.state.pending = pending;
    this.emit("phase_changed", { phase, round, currentActor }, "public");
  }

  createDiscussionOrder() {
    const alive = this.livingIds();
    if (!alive.length) return [];
    let first;
    if (this.state.day > 1 && this.state.nightDeaths.length) {
      const deadSeat = this.player(this.state.nightDeaths[0]).seat;
      for (let offset = 1; offset <= this.state.seatOrder.length; offset += 1) {
        const candidate = this.player(this.state.seatOrder[(deadSeat + offset) % this.state.seatOrder.length]);
        if (candidate.alive) { first = candidate.id; break; }
      }
    }
    first ||= this.rng.pick(alive);
    const startSeat = this.player(first).seat;
    const order = [];
    for (let offset = 0; offset < this.state.seatOrder.length; offset += 1) {
      const candidate = this.player(this.state.seatOrder[(startSeat + offset) % this.state.seatOrder.length]);
      if (candidate.alive) order.push(candidate.id);
    }
    this.state.discussionOrder = order;
    this.state.rng = this.rng.snapshot();
    this.emit("discussion_order", { day: this.state.day, order, first }, "public");
    return [...order];
  }

  recordSpeech(playerId, { speech = "", claims = [] } = {}) {
    const player = this.requireAlive(playerId);
    const safeSpeech = String(speech).slice(0, 2000);
    const normalizedClaims = Array.isArray(claims) ? claims.map((claim) => ({ ...clone(claim), playerId, day: this.state.day, round: this.state.round })) : [];
    player.claimHistory.push(...normalizedClaims);
    this.emit("speech", { playerId, speech: safeSpeech, round: this.state.round, claims: normalizedClaims }, "public");
    for (const claim of normalizedClaims) this.emit("claim", claim, "public");
    return { speech: safeSpeech, claims: normalizedClaims };
  }

  /** withSpeech: 議論中に発言と同時に行ったCO。公開記録でCOフェーズのCOと区別して示す。 */
  applyCo(playerId, action = { type: "none" }, { withSpeech = false } = {}) {
    const player = this.requireAlive(playerId);
    const requested = action?.type || "none";
    if (!CO_TYPES.includes(requested)) throw new GameRuleError("CO操作が不正です");
    // 未COからの change は declare と同義。役職名の意味づけを1か所に閉じ込める。
    const type = requested === "change" && !player.currentCo ? "declare" : requested;
    if (["declare", "change"].includes(type) && !ROLE_IDS.includes(action.role)) throw new GameRuleError("CO役職が不正です");
    const before = player.currentCo;
    if (type === "declare" || type === "change") player.currentCo = action.role;
    if (type === "withdraw") player.currentCo = null;
    // 適用されなかった役職名は記録にも公開イベントにも残さない（真の役職が漏れる経路になる）。
    const claimedRole = ["declare", "change"].includes(type) ? action.role : null;
    const record = { playerId, day: this.state.day, phase: this.state.phase, type, claimedRole, before, after: player.currentCo, ...(withSpeech ? { withSpeech: true } : {}) };
    if (type !== "none") {
      player.claimHistory.push({ ...record, kind: "co" });
      this.emit("co", record, "public");
    } else this.emit("co_no_action", { playerId, day: this.state.day }, "public");
    return record;
  }

  submitVote(voterId, targetId) {
    const voter = this.requireAlive(voterId);
    this.requireAlive(targetId);
    this.state.votes[voterId] = targetId;
    voter.privateInfo.votes.push({ day: this.state.day, target: targetId });
    this.emit("vote_cast", { voterId, targetId }, "secret");
  }

  resolveVotes() {
    const voters = this.livingIds();
    if (!voters.every((id) => this.state.votes[id])) throw new GameRuleError("全員の投票が揃っていません", "INCOMPLETE_VOTES");
    const tally = Object.fromEntries(voters.map((id) => [id, 0]));
    for (const target of Object.values(this.state.votes)) tally[target] = (tally[target] || 0) + 1;
    const max = Math.max(...Object.values(tally));
    const tied = Object.keys(tally).filter((id) => tally[id] === max);
    const executed = this.rng.pick(tied);
    this.player(executed).alive = false;
    this.state.executions.push({ day: this.state.day, playerId: executed });
    this.state.publicVoteTallies.push({ day: this.state.day, tally });
    this.state.rng = this.rng.snapshot();
    this.emit("vote_result", { day: this.state.day, tally }, "public");
    this.emit("execution", { day: this.state.day, playerId: executed, tiedCandidates: tied }, "public");
    this.state.votes = {};
    this.checkVictory("execution");
    return { tally, executed, tiedCandidates: tied };
  }

  submitAttackVote(wolfId, targetId) {
    const wolf = this.requireAlive(wolfId);
    const target = this.requireAlive(targetId);
    if (wolf.role !== ROLES.WEREWOLF) throw new GameRuleError("人狼だけが襲撃投票できます");
    if (target.role === ROLES.WEREWOLF) throw new GameRuleError("人狼は仲間を襲撃できません");
    this.state.attackVotes[wolfId] = targetId;
    wolf.privateInfo.attackVotes.push({ day: this.state.day, target: targetId });
    this.emit("attack_vote", { wolfId, targetId, day: this.state.day }, "secret");
  }

  submitDivination(seerId, targetId) {
    const seer = this.requireAlive(seerId);
    const target = this.requireAlive(targetId);
    if (seer.role !== ROLES.SEER || seerId === targetId) throw new GameRuleError("無効な占い対象です");
    this.state.nightActions.divinations[seerId] = targetId;
    this.emit("divination_selected", { seerId, targetId, day: this.state.day }, "secret");
  }

  submitGuard(bodyguardId, targetId) {
    const guard = this.requireAlive(bodyguardId);
    this.requireAlive(targetId);
    if (guard.role !== ROLES.BODYGUARD || bodyguardId === targetId) throw new GameRuleError("無効な護衛対象です");
    const previous = [...guard.privateInfo.guards].reverse().find((g) => g.day === this.state.day - 1);
    if (previous?.target === targetId) throw new GameRuleError("前夜と同じ対象は連続護衛できません");
    this.state.nightActions.guards[bodyguardId] = targetId;
    this.emit("guard_selected", { bodyguardId, targetId, day: this.state.day }, "secret");
  }

  resolveNight() {
    const livingWolves = this.alivePlayers().filter((p) => p.role === ROLES.WEREWOLF);
    if (livingWolves.length && !livingWolves.every((p) => this.state.attackVotes[p.id])) throw new GameRuleError("人狼の襲撃投票が揃っていません");
    for (const seer of this.alivePlayers().filter((p) => p.role === ROLES.SEER)) {
      const targetId = this.state.nightActions.divinations[seer.id];
      if (!targetId) throw new GameRuleError(`${seer.id}の占いが未選択です`);
      const result = this.player(targetId).role === ROLES.WEREWOLF ? "werewolf" : "not_werewolf";
      seer.privateInfo.divinations.push({ day: this.state.day, target: targetId, result, kind: "night_divination" });
      this.emit("divination_result", { seerId: seer.id, targetId, result, day: this.state.day }, "secret");
    }
    for (const guard of this.alivePlayers().filter((p) => p.role === ROLES.BODYGUARD)) {
      const targetId = this.state.nightActions.guards[guard.id];
      if (!targetId) throw new GameRuleError(`${guard.id}の護衛が未選択です`);
      guard.privateInfo.guards.push({ day: this.state.day, target: targetId });
      this.emit("guard", { bodyguardId: guard.id, targetId, day: this.state.day }, "secret");
    }
    let attackTarget = null;
    if (livingWolves.length) {
      const candidates = [...new Set(Object.values(this.state.attackVotes))];
      const tally = Object.fromEntries(candidates.map((id) => [id, 0]));
      for (const target of Object.values(this.state.attackVotes)) tally[target] += 1;
      const max = Math.max(...Object.values(tally));
      attackTarget = this.rng.pick(Object.keys(tally).filter((id) => tally[id] === max));
      this.state.nightActions.attackTarget = attackTarget;
      this.emit("attack_resolved", { day: this.state.day, targetId: attackTarget, tally }, "secret");
    }
    const guarded = new Set(Object.values(this.state.nightActions.guards));
    const death = attackTarget && !guarded.has(attackTarget) ? attackTarget : null;
    // 護衛で襲撃が消えたことは誰にも公開されないが、観測者が夜の因果を追えないと実験にならない。
    const guardedBy = Object.entries(this.state.nightActions.guards).find(([, target]) => target === attackTarget)?.[0] ?? null;
    this.emit("attack_outcome", { day: this.state.day, targetId: attackTarget, blocked: Boolean(attackTarget && guarded.has(attackTarget)), guardedBy }, "secret");
    this.state.nightDeaths = death ? [death] : [];
    if (death) this.player(death).alive = false;
    this.emit("morning_deaths", { day: this.state.day + 1, deaths: this.state.nightDeaths }, "public");
    this.state.attackVotes = {};
    this.state.nightActions = { guards: {}, divinations: {}, attackTarget: null };
    this.state.rng = this.rng.snapshot();
    this.checkVictory("night");
    if (this.state.status !== "finished") this.state.day += 1;
    return { attackTarget, guarded: attackTarget ? guarded.has(attackTarget) : false, deaths: [...this.state.nightDeaths] };
  }

  checkVictory(trigger) {
    if (this.state.status !== "running") return this.state.winner;
    const alive = this.alivePlayers();
    const wolves = alive.filter((p) => p.role === ROLES.WEREWOLF).length;
    const countedHumans = alive.length - wolves;
    if (wolves === 0) this.finish("village", `${trigger}: すべての人狼が死亡`);
    else if (wolves >= countedHumans) this.finish("wolf", `${trigger}: 人狼数が市民として数える生存者数以上`);
    return this.state.winner;
  }

  finish(winner, reason) {
    this.state.status = "finished";
    this.state.phase = PHASES.FINISHED;
    this.state.winner = winner;
    this.state.winningReason = reason;
    this.state.pending = null;
    this.emit("game_finished", { winner, reason }, "public");
  }

  requireAlive(id) {
    const player = this.player(id);
    if (!player.alive) throw new GameRuleError(`${id}は死亡しています`, "DEAD_PLAYER");
    return player;
  }

  emit(type, payload, visibility = VISIBILITIES.PUBLIC) {
    const event = { id: ++this.seq, gameId: this.gameId, timestamp: this.now(), day: this.state.day, phase: this.state.phase, type, visibility, payload: clone(payload) };
    this.events.push(event);
    return event;
  }

  publicView() {
    return {
      gameId: this.gameId,
      status: this.state.status,
      paused: this.state.paused,
      pauseRequested: this.state.pauseRequested,
      day: this.state.day,
      phase: this.state.phase,
      round: this.state.round,
      seatOrder: [...this.state.seatOrder],
      discussionOrder: [...this.state.discussionOrder],
      currentActor: this.state.currentActor,
      players: this.state.seatOrder.map((id) => {
        const p = this.player(id);
        return { id: p.id, name: p.name, seat: p.seat, controller: p.controller, alive: p.alive, currentCo: p.currentCo };
      }),
      publicVoteTallies: clone(this.state.publicVoteTallies),
      executions: clone(this.state.executions),
      nightDeaths: clone(this.state.nightDeaths),
      winner: this.state.winner,
      winningReason: this.state.winningReason,
      pending: clone(this.state.pending),
      // publicだけ。systemイベント（LLM呼び出しの進捗）はcallTypeから夜の役職行動が割れるため、
      // 参加者向けのビューには載せない。研究用の全ログは fullExport から参照する。
      events: this.events.filter((e) => e.visibility === VISIBILITIES.PUBLIC).map(clone),
    };
  }

  privateView(playerId) {
    const p = this.player(playerId);
    return { ...this.publicView(), self: clone(p), roleDescriptionId: p.role };
  }

  /**
   * LLMへ渡す唯一の公開情報。生イベント列ではなく、人間が画面で見ているものと等価な表に正規化する。
   * 発言は初日から全文を載せる。古い日を要約に落とすと、モデルの視界が黙って削られる。
   */
  publicBrief() {
    // 公開された出来事を起きた順に並べた記録。誰がいつ何を言い、何が決まったかを入力側で並べ替えずに済む。
    const record = [];
    const deaths = [];
    for (const event of this.events) {
      if (event.visibility !== VISIBILITIES.PUBLIC) continue;
      const payload = event.payload || {};
      if (event.type === "speech") {
        record.push({
          type: "speech", day: event.day, round: payload.round ?? null, playerId: payload.playerId,
          speech: payload.speech || "", claims: (payload.claims || []).map(({ type, target, value }) => ({ type, target, value })),
        });
      } else if (event.type === "co") {
        record.push({ type: "co", day: event.day, playerId: payload.playerId, coType: payload.type, claimedRole: payload.claimedRole ?? null, before: payload.before ?? null, after: payload.after ?? null, withSpeech: Boolean(payload.withSpeech) });
      } else if (event.type === "co_no_action") {
        record.push({ type: "co_none", day: event.day, playerId: payload.playerId });
      } else if (event.type === "vote_result") {
        record.push({ type: "vote_result", day: payload.day, tally: clone(payload.tally) });
      } else if (event.type === "execution") {
        record.push({ type: "execution", day: payload.day, playerId: payload.playerId, tiedCandidates: [...(payload.tiedCandidates || [])] });
        deaths.push({ day: payload.day, playerId: payload.playerId, cause: "execution" });
      } else if (event.type === "morning_deaths") {
        record.push({ type: "morning", day: payload.day, deaths: [...(payload.deaths || [])] });
        for (const id of payload.deaths || []) deaths.push({ day: payload.day, playerId: id, cause: "attack" });
      } else if (event.type === "discussion_order") {
        record.push({ type: "discussion_order", day: payload.day, order: [...payload.order] });
      }
    }
    return {
      day: this.state.day,
      phase: this.state.phase,
      round: this.state.round,
      currentActor: this.state.currentActor,
      roleCounts: clone(this.config.roleCounts),
      players: this.state.seatOrder.map((id) => {
        const p = this.player(id);
        return { id: p.id, name: p.name, seat: p.seat, alive: p.alive, co: p.currentCo };
      }),
      record,
      deaths,
      winner: this.state.winner,
    };
  }

  snapshot() {
    this.state.rng = this.rng.snapshot();
    return { gameId: this.gameId, config: clone(this.config), state: clone(this.state), events: clone(this.events), seq: this.seq };
  }

  static restore(snapshot, options = {}) {
    const engine = new GameEngine(snapshot.config, { gameId: snapshot.gameId, ...options });
    engine.state = clone(snapshot.state);
    engine.events = clone(snapshot.events);
    engine.seq = snapshot.seq;
    engine.rng.restore(snapshot.state.rng);
    return engine;
  }
}


export function roleTeam(role) { return WOLF_TEAM.has(role) ? "wolf" : "village"; }
