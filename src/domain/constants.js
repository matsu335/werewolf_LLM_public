export const ROLES = Object.freeze({
  VILLAGER: "villager",
  SEER: "seer",
  BODYGUARD: "bodyguard",
  MADMAN: "madman",
  WEREWOLF: "werewolf",
});

export const ROLE_IDS = Object.freeze(Object.values(ROLES));
export const WOLF_TEAM = new Set([ROLES.WEREWOLF, ROLES.MADMAN]);
export const CONTROLLERS = Object.freeze({ HUMAN: "human", AI: "ai" });

// LLMとの共通言語。英語の方が安定するという見立てを実測で比べるため、固定せず試合ごとに選ぶ。
export const LANGUAGES = Object.freeze(["en", "ja"]);
export const DEFAULT_LANGUAGE = "en";
export const MAX_PLAYERS = 9;

// 唯一の正式な日本語表記。プロンプト・UI・リーク検査はすべてこの語彙だけを使う。
export const ROLE_LABELS = Object.freeze({
  [ROLES.VILLAGER]: "市民",
  [ROLES.SEER]: "占い師",
  [ROLES.BODYGUARD]: "狩人",
  [ROLES.MADMAN]: "狂人",
  [ROLES.WEREWOLF]: "人狼",
});

// 英語ではIDそのものを正式表記にする。キー名・出力値・本文で語彙が一致する。
export const ROLE_LABELS_BY_LANGUAGE = Object.freeze({
  ja: ROLE_LABELS,
  en: Object.freeze(Object.fromEntries(Object.values(ROLES).map((role) => [role, role]))),
});

// モデルが出しがちな揺れた表記をIDへ寄せる。人狼ゲームの一般語彙であり、戦略知識は含まない。
export const ROLE_ALIASES = Object.freeze({
  市民: ROLES.VILLAGER, 村人: ROLES.VILLAGER, 村民: ROLES.VILLAGER, 一般市民: ROLES.VILLAGER,
  占い師: ROLES.SEER, 占師: ROLES.SEER, 予言者: ROLES.SEER, 視力者: ROLES.SEER, 占い: ROLES.SEER,
  狩人: ROLES.BODYGUARD, 騎士: ROLES.BODYGUARD, 守衛: ROLES.BODYGUARD, 警備員: ROLES.BODYGUARD, 護衛: ROLES.BODYGUARD, ボディーガード: ROLES.BODYGUARD,
  狂人: ROLES.MADMAN, 裏切り者: ROLES.MADMAN,
  人狼: ROLES.WEREWOLF, 狼: ROLES.WEREWOLF, 狼男: ROLES.WEREWOLF, 人狼陣営: ROLES.WEREWOLF,
});

// 英語の揺れ。照合は小文字で行う。
export const ROLE_ALIASES_EN = Object.freeze({
  villager: ROLES.VILLAGER, villagers: ROLES.VILLAGER, "plain villager": ROLES.VILLAGER, townsperson: ROLES.VILLAGER,
  seer: ROLES.SEER, "fortune teller": ROLES.SEER, "fortune-teller": ROLES.SEER, oracle: ROLES.SEER,
  bodyguard: ROLES.BODYGUARD, knight: ROLES.BODYGUARD, guard: ROLES.BODYGUARD, hunter: ROLES.BODYGUARD, protector: ROLES.BODYGUARD,
  madman: ROLES.MADMAN, possessed: ROLES.MADMAN, traitor: ROLES.MADMAN, lunatic: ROLES.MADMAN,
  werewolf: ROLES.WEREWOLF, wolf: ROLES.WEREWOLF, "were-wolf": ROLES.WEREWOLF,
});

// public: 全員が見る / secret: 当事者のみ / system: 運用テレメトリ。systemはLLM入力に絶対に混ぜない。
export const VISIBILITIES = Object.freeze({ PUBLIC: "public", SECRET: "secret", SYSTEM: "system" });

export const CO_TYPES = Object.freeze(["none", "declare", "withdraw", "change"]);

// 自由形式だったClaimを固定スキーマ化するための種別。
export const CLAIM_TYPES = Object.freeze({
  DIVINATION_RESULT: "divination_result",
  GUARD: "guard",
  SUSPICION: "suspicion",
  TRUST: "trust",
  OTHER: "other",
});
export const CLAIM_TYPE_IDS = Object.freeze(Object.values(CLAIM_TYPES));
export const DIVINATION_RESULTS = Object.freeze(["werewolf", "not_werewolf"]);
export const PHASES = Object.freeze({
  SETUP: "setup",
  INITIAL_WOLF_MEETING: "initial_wolf_meeting",
  INITIAL_CO: "initial_co",
  DISCUSSION: "discussion",
  VOTE: "vote",
  NIGHT_WOLF_MEETING: "night_wolf_meeting",
  NIGHT_ACTIONS: "night_actions",
  MORNING_WOLF_MEETING: "morning_wolf_meeting",
  MORNING_CO: "morning_co",
  FINISHED: "finished",
});

// 既定の村。人狼は1人なので、人狼会議と作戦メモは発生しない。
export const DEFAULT_ROLE_COUNTS = Object.freeze({
  [ROLES.WEREWOLF]: 1,
  [ROLES.MADMAN]: 1,
  [ROLES.SEER]: 1,
  [ROLES.BODYGUARD]: 1,
  [ROLES.VILLAGER]: 1,
});
