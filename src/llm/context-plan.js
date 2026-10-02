import { CONTROLLERS, ROLE_IDS } from "../domain/constants.js";
import { gameLanguage } from "../domain/config.js";
import { CALL_TYPES } from "./prompt-store.js";
import { estimateTokens } from "./runner.js";

// 1発言が入力に占める最大量の見積り。本文はスキーマの機械的上限、Claimは平均1件、行の装飾ぶんを足す。
const SPEECH_TOKENS = { ja: 273 + 70 + 20, en: 250 + 45 + 20 };
// 1日あたりのCO・投票結果・朝の発表などの行と、固定の見出し・プレイヤー表・秘密情報。
const PER_DAY_TOKENS = 250;
const FIXED_TOKENS = 1200;
const LARGEST_ANSWER_TOKENS = 800;

/**
 * 試合を始める前に、最悪の場合の入力がコンテキスト長に収まるかを確かめる。
 * 発言は初日から全文を渡すので入力は単調に増える。途中で溢れて止まるより、始める前に断る。
 * 最悪の日数は「毎日1人処刑され、夜の死者が出ない」進行で、生存者が3人になる日まで続くとして数える。
 */
export function planContext(config, promptStore) {
  const language = gameLanguage(config);
  const players = config.players?.length ?? 0;
  let speeches = players * 2;
  let days = 1;
  for (let alive = players - 1; alive >= 3; alive -= 1) { speeches += alive; days += 1; }
  const systemTokens = Math.max(...CALL_TYPES.flatMap((callType) => ROLE_IDS.map((role) => estimateTokens(promptStore.bundle(callType, role, language).system))));
  const inputTokens = systemTokens + FIXED_TOKENS + days * PER_DAY_TOKENS + speeches * (SPEECH_TOKENS[language] ?? SPEECH_TOKENS.ja);
  const rows = (config.players || []).filter((p) => p.controller === CONTROLLERS.AI && p.llm).map((p) => {
    const contextTokens = p.llm.contextTokens ?? p.llm.numCtx ?? 16384;
    const required = inputTokens + LARGEST_ANSWER_TOKENS + (p.llm.reasoningTokens ?? 4096) + 256;
    return { playerId: p.id, contextTokens, required, fits: required <= contextTokens };
  });
  return { language, speeches, days, systemTokens, inputTokens, players: rows };
}

export function contextPlanErrors(config, promptStore) {
  const plan = planContext(config, promptStore);
  return plan.players.filter((row) => !row.fits).map((row) =>
    `${row.playerId}: 最悪の場合の入力（${plan.days}日・発言${plan.speeches}件）に約${row.required}トークン必要ですが、contextTokens は ${row.contextTokens} です。${Math.ceil(row.required / 4096) * 4096} 以上にしてください`);
}
