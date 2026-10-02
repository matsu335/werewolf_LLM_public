import { ROLE_IDS, ROLE_LABELS_BY_LANGUAGE, ROLES } from "../domain/constants.js";

/**
 * LLMへ渡す入力を、構造化データから読める説明文に描き起こす。
 * JSONをそのまま渡していたころ、モデルは validTargets が入力にあるのに「与えられていない」と推論し、
 * 前の話者の発言を「出力例」と読んで一字一句写していた。誰がどの発言をしたか、自分が誰か、
 * 誰が生きているかを一目で読める形にする。載せる情報は構造化データと同じで、要約も省略もしない。
 */
export function renderInput(input, language = "ja") {
  const L = language === "en" ? EN : JA;
  const roles = ROLE_LABELS_BY_LANGUAGE[language] || ROLE_LABELS_BY_LANGUAGE.ja;
  const ctx = { L, roles, state: input?.publicState || {}, self: input?.self || {}, task: input?.task || {} };
  const sections = [
    section(L.youTitle, youLines(ctx)),
    section(L.situationTitle, situationLines(ctx)),
    section(L.playersTitle, playerLines(ctx)),
    section(L.recordTitle, recordLines(ctx)),
    section(L.privateTitle, privateLines(ctx)),
    ctx.task.meeting ? section(L.meetingTitle, meetingLines(ctx)) : null,
    ctx.task.validTargets ? section(L.choicesTitle, [ctx.task.validTargets.length ? ctx.task.validTargets.join(", ") : L.noChoices]) : null,
  ];
  return sections.filter(Boolean).join("\n\n");
}

function section(title, lines) {
  return [`## ${title}`, ...lines].join("\n");
}

function youLines({ L, roles, self }) {
  const lines = [L.youAre(self.id, roles[self.role] ?? self.role)];
  if (self.role === ROLES.WEREWOLF) {
    const partners = self.privateInfo?.wolfPartners || [];
    lines.push(partners.length ? L.partners(partners.join(", ")) : L.noPartners);
  }
  return lines;
}

function situationLines(ctx) {
  const { L, state, task, self } = ctx;
  const lines = [L.phase(task.callType, state, task, self)];
  const composition = ROLE_IDS.map((role) => L.count(ctx.roles[role] ?? role, state.roleCounts?.[role] ?? 0)).join(L.listSep);
  const total = ROLE_IDS.reduce((sum, role) => sum + (state.roleCounts?.[role] ?? 0), 0);
  lines.push(L.composition(composition, total));
  return lines;
}

function playerLines({ L, roles, state, self }) {
  const deaths = Object.fromEntries((state.deaths || []).map((d) => [d.playerId, d]));
  return (state.players || []).map((p) => {
    const parts = [p.id === self.id ? L.youMark(p.id) : p.id];
    parts.push(p.alive ? L.alive : L.dead(deaths[p.id]));
    parts.push(p.co ? L.currentCo(roles[p.co] ?? p.co) : L.noCo);
    return `- ${parts.join(L.fieldSep)}`;
  });
}

function recordLines({ L, roles, state }) {
  const record = state.record || [];
  if (!record.length) return [L.nothingYet];
  const lines = [];
  let day = null;
  let round;
  for (const entry of record) {
    if (entry.day !== day) {
      day = entry.day;
      round = undefined;
      lines.push(`### ${L.dayHeader(day)}`);
    }
    if (entry.type === "speech") {
      if (entry.round !== round) {
        round = entry.round;
        if (round != null) lines.push(L.roundHeader(round));
      }
      lines.push(`- ${entry.playerId}: "${entry.speech}"`);
      for (const claim of entry.claims || []) lines.push(`    ${L.claim(claim)}`);
    } else if (entry.type === "co") lines.push(`- ${L.coEntry(entry, roles)}`);
    else if (entry.type === "co_none") lines.push(`- ${L.coNone(entry.playerId)}`);
    else if (entry.type === "discussion_order") lines.push(`- ${L.order(entry.order.join(" → "))}`);
    else if (entry.type === "vote_result") lines.push(`- ${L.voteResult(tallyText(entry.tally, L))}`);
    else if (entry.type === "execution") lines.push(`- ${L.execution(entry.playerId, entry.tiedCandidates || [])}`);
    else if (entry.type === "morning") lines.push(`- ${entry.deaths.length ? L.morningDeaths(entry.deaths.join(", ")) : L.morningNoDeaths}`);
  }
  return lines;
}

function tallyText(tally, L) {
  const rows = Object.entries(tally || {}).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  return rows.length ? rows.map(([id, n]) => L.votes(id, n)).join(L.listSep) : L.noVotes;
}

function privateLines({ L, self }) {
  const info = self.privateInfo || {};
  const lines = [];
  if (self.role === ROLES.SEER) {
    const rows = info.divinations || [];
    lines.push(rows.length ? L.divinationsHeader : L.noDivinations);
    for (const d of rows) lines.push(`- ${L.divination(d)}`);
  }
  if (self.role === ROLES.BODYGUARD) {
    const rows = info.guards || [];
    lines.push(rows.length ? L.guardsHeader : L.noGuards);
    for (const g of rows) lines.push(`- ${L.guardEntry(g)}`);
  }
  if (self.role === ROLES.WEREWOLF) {
    const attacks = info.attackVotes || [];
    if (attacks.length) lines.push(L.attackVotesHeader);
    for (const a of attacks) lines.push(`- ${L.attackVote(a)}`);
    lines.push(self.wolfStrategyMemory ? L.memo(self.wolfStrategyMemory) : L.noMemo);
  }
  const votes = info.votes || [];
  lines.push(votes.length ? L.ownVotesHeader : L.noOwnVotes);
  for (const v of votes) lines.push(`- ${L.ownVote(v)}`);
  return lines;
}

function meetingLines({ L, task }) {
  const { purpose, messages = [] } = task.meeting;
  const lines = [L.meetingPurpose(purpose)];
  if (!messages.length) lines.push(L.meetingEmpty);
  for (const m of messages) lines.push(`- ${m.playerId}: "${m.message}"`);
  return lines;
}

const CLAIM_EN = { divination_result: "divination result", guard: "protection", suspicion: "suspicion", trust: "trust", other: "other" };
const CLAIM_JA = { divination_result: "占い結果", guard: "護衛", suspicion: "疑い", trust: "信頼", other: "その他" };

const EN = {
  youTitle: "You", situationTitle: "Current situation", playersTitle: "Players (seat order)",
  recordTitle: "Public record so far (everything every player has seen, in order)",
  privateTitle: "Private information (only you know this)", meetingTitle: "Secret werewolf meeting (only werewolves see this)",
  choicesTitle: "Players you can choose", noChoices: "(none)",
  youAre: (id, role) => `You are ${id}. Your true role is ${role}.`,
  partners: (ids) => `Your fellow werewolves: ${ids}.`,
  noPartners: "There are no other werewolves besides you.",
  count: (role, n) => `${role} ${n}`, listSep: ", ", fieldSep: " | ",
  composition: (text, total) => `Role composition of this game: ${text} (${total} players in total).`,
  youMark: (id) => `${id} (you)`,
  alive: "alive",
  dead: (d) => (d?.cause === "execution" ? `dead (executed on day ${d.day})` : d ? `dead (found dead on the morning of day ${d.day})` : "dead"),
  currentCo: (role) => `current CO: ${role}`, noCo: "no CO",
  nothingYet: "Nothing has happened yet.",
  dayHeader: (day) => `Day ${day}`,
  roundHeader: (round) => `Discussion round ${round}:`,
  claim: (c) => `(claim attached: ${CLAIM_EN[c.type] ?? c.type}${c.target ? ` → ${c.target}` : ""}${c.value ? `: ${c.value}` : ""})`,
  coEntry: (e, roles) => (e.coType === "withdraw"
    ? `${e.playerId} withdrew their CO (was ${roles[e.before] ?? e.before}).`
    : e.coType === "change" ? `${e.playerId} changed their CO from ${roles[e.before] ?? e.before} to ${roles[e.after] ?? e.after}.`
      : `${e.playerId} CO'd ${roles[e.claimedRole] ?? e.claimedRole}.`),
  coNone: (id) => `${id} made no CO.`,
  order: (order) => `Speaking order: ${order}`,
  votes: (id, n) => `${id} ${n} vote${n === 1 ? "" : "s"}`, noVotes: "no votes",
  voteResult: (text) => `Execution vote result (only the counts are public): ${text}.`,
  execution: (id, tied) => `${id} was executed.${tied.length > 1 ? ` (${tied.join(", ")} were tied; ${id} was chosen at random.)` : ""}`,
  morningDeaths: (ids) => `Morning announcement: ${ids} died during the night.`,
  morningNoDeaths: "Morning announcement: nobody died during the night.",
  divinationsHeader: "Your divination results:",
  noDivinations: "You have no divination results yet.",
  divination: (d) => `${d.kind === "initial_random_white" ? "Initial result (before day 1)" : `Night of day ${d.day}`}: ${d.target} is ${d.result === "werewolf" ? "a werewolf" : "not a werewolf"}.`,
  guardsHeader: "Your protections:", noGuards: "You have not protected anyone yet.",
  guardEntry: (g) => `Night of day ${g.day}: you protected ${g.target}.`,
  attackVotesHeader: "Your attack votes:",
  attackVote: (a) => `Night of day ${a.day}: you voted to attack ${a.target}.`,
  memo: (text) => `Your werewolf strategy memo (written by you after a werewolf meeting): "${text}"`,
  noMemo: "You have no werewolf strategy memo.",
  ownVotesHeader: "Your execution votes (only you know whom you voted for):",
  ownVote: (v) => `Day ${v.day}: you voted to execute ${v.target}.`,
  noOwnVotes: "You have not voted yet.",
  meetingPurpose: (purpose) => ({
    initial: "This meeting takes place before the first day's discussion begins.",
    night: "This meeting takes place at night, after today's execution and before tonight's attack target is chosen.",
    morning: "This meeting takes place in the morning, after the night's result was announced and before the morning CO phase.",
  })[purpose] ?? `Meeting: ${purpose}`,
  meetingEmpty: "Nobody has spoken in this meeting yet.",
  phase: (callType, state, task, self) => {
    const day = state.day;
    if (callType === "co") {
      return `${state.phase === "initial_co" ? `Day ${day}, before the discussion begins` : `Morning of day ${day}, before the discussion begins`}: CO phase. Every living player decides at the same time whether to CO.`;
    }
    if (callType === "discussion") {
      const rounds = day === 1 ? "Day 1 has 2 discussion rounds" : `Day ${day} has 1 discussion round`;
      const turn = task.simultaneous
        ? "All players write their speeches for this round at the same time, from this same situation; you cannot see the others' speeches for this round."
        : "It is your turn to speak.";
      return `Day ${day}, daytime discussion, round ${state.round ?? 1}. ${rounds}; the execution vote follows the discussion. ${turn}`;
    }
    if (callType === "vote") return `Day ${day}, execution vote. Today's discussion is over. Every living player votes at the same time.`;
    if (callType === "attack" || callType === "divination" || callType === "guard") {
      return `Night of day ${day}: night actions. Today's execution is over. The werewolves, the seer and the bodyguard each choose their target at the same time.`;
    }
    if (callType === "wolf_meeting") return `Day ${day}: secret werewolf meeting.`;
    if (callType === "strategy_memory") return `Day ${day}: the secret werewolf meeting has just ended. Update your own strategy memo.`;
    return `Day ${day}.`;
  },
};

const JA = {
  youTitle: "あなた", situationTitle: "現在の状況", playersTitle: "プレイヤー（座席順）",
  recordTitle: "これまでの公開記録（全員が見た出来事を起きた順に）",
  privateTitle: "あなただけが知っている情報", meetingTitle: "人狼の秘密会議（人狼だけが見られる）",
  choicesTitle: "今回選べる相手", noChoices: "（なし）",
  youAre: (id, role) => `あなたは ${id} です。あなたの真の役職は${role}です。`,
  partners: (ids) => `あなたの仲間の人狼: ${ids}`,
  noPartners: "あなた以外に人狼はいません。",
  count: (role, n) => `${role}${n}`, listSep: "・", fieldSep: " ｜ ",
  composition: (text, total) => `この試合の配役: ${text}（合計${total}人）`,
  youMark: (id) => `${id}（あなた）`,
  alive: "生存",
  dead: (d) => (d?.cause === "execution" ? `死亡（${d.day}日目に処刑）` : d ? `死亡（${d.day}日目の朝に死亡が判明）` : "死亡"),
  currentCo: (role) => `現在のCO: ${role}`, noCo: "COなし",
  nothingYet: "まだ何も起きていません。",
  dayHeader: (day) => `${day}日目`,
  roundHeader: (round) => `議論 ${round}巡目:`,
  claim: (c) => `（添えられた主張: ${CLAIM_JA[c.type] ?? c.type}${c.target ? ` → ${c.target}` : ""}${c.value ? `: ${c.value}` : ""}）`,
  coEntry: (e, roles) => (e.coType === "withdraw"
    ? `${e.playerId} がCOを撤回しました（撤回前: ${roles[e.before] ?? e.before}）。`
    : e.coType === "change" ? `${e.playerId} がCOを${roles[e.before] ?? e.before}から${roles[e.after] ?? e.after}に変更しました。`
      : `${e.playerId} が${roles[e.claimedRole] ?? e.claimedRole}としてCOしました。`),
  coNone: (id) => `${id} はCOしませんでした。`,
  order: (order) => `発言順: ${order}`,
  votes: (id, n) => `${id} ${n}票`, noVotes: "得票なし",
  voteResult: (text) => `処刑投票の結果（公開されるのは票数だけ）: ${text}`,
  execution: (id, tied) => `${id} が処刑されました。${tied.length > 1 ? `（${tied.join("、")} が同数で、無作為に ${id} が選ばれました）` : ""}`,
  morningDeaths: (ids) => `朝の発表: 夜のあいだに ${ids} が死亡しました。`,
  morningNoDeaths: "朝の発表: 夜のあいだの死亡者はいません。",
  divinationsHeader: "あなたの占い結果:",
  noDivinations: "占い結果はまだありません。",
  divination: (d) => `${d.kind === "initial_random_white" ? "初期結果（1日目の前）" : `${d.day}日目の夜`}: ${d.target} は${d.result === "werewolf" ? "人狼" : "人狼ではない"}。`,
  guardsHeader: "あなたの護衛履歴:", noGuards: "まだ誰も護衛していません。",
  guardEntry: (g) => `${g.day}日目の夜: ${g.target} を護衛しました。`,
  attackVotesHeader: "あなたの襲撃投票:",
  attackVote: (a) => `${a.day}日目の夜: ${a.target} への襲撃に投票しました。`,
  memo: (text) => `あなたの作戦メモ（人狼会議の後にあなた自身が書いたもの）:「${text}」`,
  noMemo: "作戦メモはありません。",
  ownVotesHeader: "あなたの処刑投票（誰に入れたかはあなただけが知っている）:",
  ownVote: (v) => `${v.day}日目: ${v.target} の処刑に投票しました。`,
  noOwnVotes: "まだ投票していません。",
  meetingPurpose: (purpose) => ({
    initial: "この会議は1日目の議論が始まる前に行われています。",
    night: "この会議は夜、今日の処刑の後、今夜の襲撃先を決める前に行われています。",
    morning: "この会議は朝、夜の結果が発表された後、朝のCOフェーズの前に行われています。",
  })[purpose] ?? `会議: ${purpose}`,
  meetingEmpty: "この会議ではまだ誰も発言していません。",
  phase: (callType, state, task) => {
    const day = state.day;
    if (callType === "co") {
      return `${state.phase === "initial_co" ? `${day}日目、議論の前` : `${day}日目の朝、議論の前`}: COフェーズ。生存者全員が同時に、COするかどうかを決めます。`;
    }
    if (callType === "discussion") {
      const rounds = day === 1 ? "1日目の議論は2巡" : `${day}日目の議論は1巡`;
      const turn = task.simultaneous
        ? "この巡の発言は全員が同じ状況から同時に書きます。この巡の他の人の発言は見えません。"
        : "いまはあなたの発言の番です。";
      return `${day}日目・昼の議論 ${state.round ?? 1}巡目。${rounds}で、議論の後に処刑投票があります。${turn}`;
    }
    if (callType === "vote") return `${day}日目・処刑投票。今日の議論は終わりました。生存者全員が同時に投票します。`;
    if (callType === "attack" || callType === "divination" || callType === "guard") {
      return `${day}日目の夜・夜行動。今日の処刑は終わりました。人狼・占い師・狩人がそれぞれ同時に対象を選びます。`;
    }
    if (callType === "wolf_meeting") return `${day}日目・人狼の秘密会議。`;
    if (callType === "strategy_memory") return `${day}日目・人狼の秘密会議が終わったところです。あなた自身の作戦メモを更新してください。`;
    return `${day}日目。`;
  },
};
