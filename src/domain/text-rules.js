import { ROLE_ALIASES, ROLE_ALIASES_EN, ROLE_IDS, ROLE_LABELS } from "./constants.js";

const PARTNERSHIP = {
  ja: /仲間|味方|同じ陣営|共犯/u,
  en: /\b(?:partners?|ally|allies|allied|teammates?|fellow\s+(?:were)?wolf|fellow\s+(?:were)?wolves|same\s+(?:team|side)|accomplices?|comrades?)\b/iu,
};

export function normalizeRoleId(value) {
  if (value == null || value === "") return null;
  const key = String(value).trim();
  const lower = key.toLowerCase().replace(/\s+/g, " ");
  if (ROLE_IDS.includes(lower)) return lower;
  return ROLE_ALIASES[key] || ROLE_ALIASES_EN[lower] || lower;
}

export function roleLabel(role) {
  return ROLE_LABELS[role] || String(role ?? "");
}

export function containsJapanese(value) {
  return /[぀-ヿ㐀-鿿]/u.test(String(value ?? ""));
}

/**
 * 発言が試合の言語で書かれていないか。
 * 英語の試合では日本語・中国語・韓国語の文字を1字でも含めば違反とする（qwen3は思考中に中国語を混ぜる）。
 * 日本語の試合は従来どおり日本語の文字を含むかだけを見るため、中国語の文は通ってしまう。
 */
export function violatesLanguage(value, language) {
  const text = String(value ?? "");
  if (language === "en") return /[぀-ヿ㐀-鿿가-힯豈-﫿]/u.test(text);
  return !containsJapanese(text);
}

export function splitSentences(text, language = "ja") {
  const source = String(text ?? "");
  const pattern = language === "en" ? /(?<=[.!?\n])\s*/u : /(?<=[。！？\n])/u;
  return source.split(pattern).filter((part) => part !== "");
}

/** 仲間関係を示す語を含むか。仲間のIDと同じ文に出たら秘密情報の漏洩とみなす。 */
export function mentionsPartnership(text, language = "ja") {
  return (PARTNERSHIP[language] || PARTNERSHIP.ja).test(String(text ?? ""));
}
