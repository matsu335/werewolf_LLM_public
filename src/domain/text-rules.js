import { ROLE_ALIASES, ROLE_ALIASES_EN, ROLE_IDS, ROLE_LABELS } from "./constants.js";

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const alternation = (words) => [...new Set(words)].sort((a, b) => b.length - a.length).map(escape).join("|");

const ROLE_WORD_PATTERN_JA = alternation([...Object.keys(ROLE_ALIASES), ...Object.values(ROLE_LABELS)]);
const ROLE_WORD_PATTERN_EN = alternation(Object.keys(ROLE_ALIASES_EN)).replace(/ /g, "\\s+");

/*
 * 「私は占い師です」「俺が人狼だ」のような自分の役職の名乗りだけを拾う。
 * 「私はP3が人狼だと思う」「村人の安全を守りたい」を巻き込まないよう、
 * 主語と役職語の間に別の主語（が・は・プレイヤーID・読点）が入る形は除外する。
 * 「私は人狼ではない」のような否定は名乗りではないので、TAILを取り出して後で除く。
 */
const SELF = "(?:私|わたし|俺|おれ|僕|ぼく|自分|当方)";
const LINK = "(?:の(?:真の)?役職)?(?:は|が|こそ|として)";
const GAP = "[^。！？\\n、がはPＰ]{0,12}?";
const TAIL = "(ではない|じゃない|ではありません|ではなく|じゃなく|です|だ|である|でした|だった|なので|だから|ですが|だが|として|CO|$|[^ぁ-んァ-ヶ一-龠])";
const SELF_CLAIM_JA = new RegExp(`${SELF}${LINK}${GAP}(${ROLE_WORD_PATTERN_JA})${TAIL}`, "gu");
const NEGATION_JA = /^(?:では|じゃ)/u;

/*
 * 英語の名乗り。主語の直後に置ける語を冠詞・強調・否定の許可リストに限ることで、
 * "I think P3 is the werewolf" や "I'm sure the seer is P1" のように
 * 主語と役職語の間に別の述語が挟まる文を巻き込まない。
 */
const SUBJECT_EN = "\\b(?:i\\s*['’]\\s*m|i\\s+am|i\\s+was|i\\s+wasn['’]t|i\\s+have\\s+been|my\\s+(?:true\\s+|real\\s+|actual\\s+)?role\\s+(?:is|was)|i\\s+(?:claim|declare|co|come\\s+out\\s+as|am\\s+coming\\s+out\\s+as)(?:\\s+to\\s+be|\\s+as)?)";
const MODIFIERS_EN = "((?:(?:the|a|an|really|actually|truly|also|indeed|definitely|certainly|just|only|simply|real|true|genuine|genuinely|honestly|not|never|no|one|of)\\s+){0,5})";
const SELF_CLAIM_EN = new RegExp(`${SUBJECT_EN}\\s+${MODIFIERS_EN}(${ROLE_WORD_PATTERN_EN})(?![a-z-])`, "giu");
// "As the seer, I checked P2" のように、役職を名乗ってから一人称で続ける形。
const AS_ROLE_EN = new RegExp(`\\bas\\s+(?:(?:the|a|an)\\s+)?(${ROLE_WORD_PATTERN_EN})\\s*,?\\s+i\\b`, "giu");
const NEGATION_EN = /\b(?:not|never|no)\b|n['’]t/iu;

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

/** テキストに現れる役職語をID化して返す。主語は問わない。 */
export function findRoleWords(text, language = "ja") {
  const found = new Set();
  const pattern = language === "en" ? new RegExp(`\\b(?:${ROLE_WORD_PATTERN_EN})(?![a-z-])`, "giu") : new RegExp(ROLE_WORD_PATTERN_JA, "gu");
  for (const match of String(text ?? "").matchAll(pattern)) {
    const role = normalizeRoleId(match[0]);
    if (ROLE_IDS.includes(role)) found.add(role);
  }
  return [...found];
}

/**
 * 発言内で自分のものとして名乗られた役職IDを返す。「〜ではない」という否定は含めない。
 * COは専用操作で行うというルールの検査に使う。
 */
export function findSelfRoleClaims(text, language = "ja") {
  const source = String(text ?? "");
  const found = new Set();
  if (language === "en") {
    for (const match of source.matchAll(SELF_CLAIM_EN)) {
      if (NEGATION_EN.test(match[0].slice(0, match[0].length - match[2].length))) continue;
      addRole(found, match[2]);
    }
    for (const match of source.matchAll(AS_ROLE_EN)) addRole(found, match[1]);
  } else {
    for (const match of source.matchAll(SELF_CLAIM_JA)) {
      if (NEGATION_JA.test(match[2] ?? "")) continue;
      addRole(found, match[1]);
    }
  }
  return [...found];
}

function addRole(found, word) {
  const role = normalizeRoleId(word);
  if (ROLE_IDS.includes(role)) found.add(role);
}

/**
 * 発言の中で、公開済みのCOと一致しない役職の名乗り。
 * 名乗り自体は禁じない。禁じたいのは「COをせず発言の中だけで役職を主張する」ことなので、
 * COしている役職を発言でも名乗るのは許す。
 */
export function unbackedRoleClaims(text, language, currentCo) {
  return findSelfRoleClaims(text, language).filter((role) => role !== currentCo);
}

/**
 * COの裏付けがない名乗りを含む文だけを落として残りを保持する。
 * 内容をまるごと捨てると「発言なし」という偽の推理材料が生まれるため、文単位で削る。
 */
export function redactUnbackedRoleClaims(text, language = "ja", currentCo = null) {
  const source = String(text ?? "");
  if (!unbackedRoleClaims(source, language, currentCo).length) return { text: source, redacted: false };
  const kept = splitSentences(source, language).filter((sentence) => !unbackedRoleClaims(sentence, language, currentCo).length);
  return { text: kept.join(language === "en" ? " " : "").replace(/\s{2,}/g, " ").trim(), redacted: true };
}
