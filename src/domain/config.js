import { CONTROLLERS, DEFAULT_LANGUAGE, DEFAULT_ROLE_COUNTS, LANGUAGES, MAX_PLAYERS, ROLE_IDS } from "./constants.js";

export function defaultLlmConfig() {
  return {
    baseUrl: "http://localhost:11434/v1",
    apiKey: "ollama",
    model: "qwen3:8b",
    // auto: Ollamaならネイティブの /api/chat、それ以外はOpenAI互換の /chat/completions。
    // OllamaのOpenAI互換エンドポイントは num_ctx を無視して既定長で読み込み直し、入力を黙って切り詰める。
    api: "auto",
    temperature: 0.7,
    // 既定でseedを固定する。未固定だと同じ局面を再現できず、観察結果を比較できない。
    seed: 20260927,
    maxTokens: 1600,
    // 思考するモデル向けの追加枠。JSON本体の予算とは別に積む。思考で枠を使い切るとcontentが空で返る。
    // qwen3:8bの思考は実測で最大12,700文字（英語で約3,200トークン）。足りないと劣化したリトライ出力が本番に残る。
    reasoningTokens: 4096,
    // 推論サーバのコンテキスト長。Ollamaには num_ctx としてそのまま送る。入力がこれを超える場合は送らずに試合を止める。
    contextTokens: 16384,
    timeoutMs: 180000,
    retries: 2,
    extra: {},
  };
}

export function defaultConfig() {
  const players = Object.values(DEFAULT_ROLE_COUNTS).reduce((sum, n) => sum + n, 0);
  return {
    name: `標準${players}人村`,
    seed: Math.floor(Date.now() % 2147483647),
    language: DEFAULT_LANGUAGE,
    roleCounts: { ...DEFAULT_ROLE_COUNTS },
    players: Array.from({ length: players }, (_, i) => ({
      id: `P${i + 1}`,
      name: `プレイヤー${i + 1}`,
      controller: CONTROLLERS.AI,
      fixedRole: null,
      llm: defaultLlmConfig(),
    })),
    initialCoPhase: true,
    wolfMeetingMode: "sequential",
    llmExecutionMode: "serial",
    // sequential は順番に発言（直前の発言を読める）、simultaneous は全員同一スナップショットから同時発言。
    // 同調カスケードが進行方式由来かモデル由来かを切り分けるための比較条件。
    discussionMode: "sequential",
    autoRunAllAi: true,
  };
}

export function validateConfig(config) {
  const errors = [];
  if (!config || typeof config !== "object") return ["設定がありません"];
  const players = Array.isArray(config.players) ? config.players : [];
  if (players.length < 1) errors.push("プレイヤーは1人以上必要です");
  if (players.length > MAX_PLAYERS) errors.push(`プレイヤーは最大${MAX_PLAYERS}人です`);
  const ids = players.map((p) => p.id);
  if (new Set(ids).size !== ids.length || ids.some((id) => !id)) errors.push("プレイヤーIDは空でない一意の値にしてください");
  for (const player of players) {
    if (!Object.values(CONTROLLERS).includes(player.controller)) errors.push(`${player.id}: controllerが不正です`);
    if (player.fixedRole && !ROLE_IDS.includes(player.fixedRole)) errors.push(`${player.id}: fixedRoleが不正です`);
    if (player.controller === CONTROLLERS.AI && !player.llm) errors.push(`${player.id}: AI設定がありません`);
    if (player.llm?.api && !["auto", "ollama", "openai"].includes(player.llm.api)) errors.push(`${player.id}: APIの種別が不正です`);
  }
  let totalRoles = 0;
  for (const role of ROLE_IDS) {
    const count = config.roleCounts?.[role] ?? 0;
    if (!Number.isInteger(count) || count < 0) errors.push(`${role}の人数は0以上の整数にしてください`);
    else totalRoles += count;
    const fixed = players.filter((p) => p.fixedRole === role).length;
    if (Number.isInteger(count) && fixed > count) errors.push(`${role}の固定割当が設定人数を超えています`);
  }
  if (totalRoles !== players.length) errors.push(`役職合計(${totalRoles})とプレイヤー数(${players.length})が一致しません`);
  if (config.language != null && !LANGUAGES.includes(config.language)) errors.push("LLMの言語が不正です");
  if (!["serial", "parallel"].includes(config.llmExecutionMode)) errors.push("LLM実行方式が不正です");
  if (!["sequential", "independent_first"].includes(config.wolfMeetingMode)) errors.push("人狼会議方式が不正です");
  if (config.discussionMode && !["sequential", "simultaneous"].includes(config.discussionMode)) errors.push("昼の発言方式が不正です");
  return errors;
}

/** 言語が未設定の試合は、言語切り替えを入れる前の日本語の試合。 */
export function gameLanguage(config) {
  return LANGUAGES.includes(config?.language) ? config.language : "ja";
}
