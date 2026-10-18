import { ROLE_LABELS_BY_LANGUAGE } from "../domain/constants.js";

/**
 * モデルが読む定型文。検査の却下理由は修復依頼としてそのままモデルへ返るため、
 * 画面向けの文言ではなく、試合の言語に合わせてここで管理する。
 */
const TEXT = {
  ja: {
    outputRulesHeader: "【最優先の出力規則】",
    outputRules: [
      "- 指定されたJSONオブジェクト1個だけを返すこと。前置き、後書き、Markdown、コードフェンスは禁止。",
      "- キー名は指定どおりに使い、指定外のキーを追加しないこと。",
      "- 自然言語の値はすべて日本語で書くこと。",
      "- 各フィールドの文字数上限の中に収めること。上限は上限であり、内容に必要な分より短くする必要はない。上限を大きく超えた部分は機械的に切り捨てられ、出力が無効になる。",
    ],
    thoughtRule: "- 考えたいことは private_thought フィールドの中だけに、短く書くこと。そのフィールドは他プレイヤーには公開されない。",
    vocabulary: (list) => `- 役職を指すときは次の語だけを使うこと: ${list}`,
    noOtherRoles: "- この試合に存在しない役職名を使わないこと。",
    repairHeader: "前回の出力は受理できませんでした。判断の中身は変えず、下の指摘だけを直して、JSONオブジェクト1個だけを返してください。",
    repairReason: (reason) => `却下理由: ${reason}`,
    repairTruncated: "前回は文字数上限に達して値が途中で切れました。同じ論点を、短い日本語で言い切ってください。",
    repairPrevious: (text) => `前回の出力(先頭1200文字): ${text}`,
    fallbackSpeech: "今回は判断材料が足りないため、意見を保留します。",
    coTypeInvalid: (type) => `CO操作の種別が不正です: ${type}`,
    coRoleInvalid: "COする役職が不正です",
    speechNotObject: "発言はオブジェクトで返してください",
    speechEmpty: "公開発言が空です",
    speechLanguage: "公開発言が日本語ではありません。speechの内容と論拠は変えず、そのまま日本語へ訳してください",
    speechLeak: (list) => `公開発言に秘密情報が含まれています（${list}）`,
    partnerReveal: "仲間の正体を示しています",
    untethered: (list) => `claimsだけで伝えようとしている主張があります（${list}）。その主張は公開発言の本文で対象のIDを挙げて述べるか、claimsから外してください`,
    actions: { execute_target: "昼の処刑投票", attack_target: "夜の襲撃", divine_target: "夜の占い", guard_target: "夜の護衛" },
    sceneConfusion: (action, other, key) => `いまは${action}の場面です。${other}の対象ではなく、${key} に${action}の対象を1人書いてください`,
    notCandidate: (key, target, valid) => `${key} が候補に含まれていません: ${target}。選べるのは ${valid} のいずれかです`,
    placeholder: (key) => `${key} に説明用のプレースホルダがそのまま入っています。<> で囲んだ例示ではなく、あなた自身の内容を書いてください`,
    meetingLanguage: "人狼会議の発言が日本語ではありません。内容は変えず、そのまま日本語へ訳してください",
  },
  en: {
    outputRulesHeader: "[Output rules: highest priority]",
    outputRules: [
      "- Return exactly one JSON object as specified. No preamble, no afterword, no Markdown, no code fences.",
      "- Use the key names exactly as specified, and do not add unspecified keys.",
      "- Write every natural-language value in English.",
      "- Keep each field within its length limit. The limit is a ceiling: you do not need to make a value shorter than its content requires. Text far beyond the limit is cut off mechanically, which makes the output invalid.",
    ],
    thoughtRule: "- Write what you want to think about only inside the private_thought field, briefly. That field is not shown to other players.",
    vocabulary: (list) => `- When referring to roles, use only these words: ${list}`,
    noOtherRoles: "- Do not use role names that do not exist in this game.",
    repairHeader: "Your previous output could not be accepted. Do not change the substance of your decision; fix only the point below, and return exactly one JSON object.",
    repairReason: (reason) => `Reason for rejection: ${reason}`,
    repairTruncated: "Last time a value was cut off because it reached the length limit. Make the same point completely, in shorter English.",
    repairPrevious: (text) => `Your previous output (first 1200 characters): ${text}`,
    fallbackSpeech: "I do not have enough to go on this time, so I will hold off on giving an opinion.",
    coTypeInvalid: (type) => `Invalid CO type: ${type}`,
    coRoleInvalid: "Invalid role for the CO",
    speechNotObject: "Return the speech as an object",
    speechEmpty: "The public speech is empty",
    speechLanguage: "The public speech is not in English. Keep the content and reasoning of speech unchanged and translate it into English as is",
    speechLeak: (list) => `The public speech contains secret information (${list})`,
    partnerReveal: "it reveals the identity of a fellow werewolf",
    untethered: (list) => `Some claims are conveyed only through claims (${list}). State each of them in the body of the public speech naming the target's ID, or remove them from claims`,
    actions: { execute_target: "the daytime execution vote", attack_target: "the night attack", divine_target: "the night divination", guard_target: "the night protection" },
    sceneConfusion: (action, other, key) => `This is ${action}. Do not give a target for ${other}; write one target for ${action} in ${key}`,
    notCandidate: (key, target, valid) => `${key} is not one of the candidates: ${target}. You can choose one of ${valid}`,
    placeholder: (key) => `${key} still contains the illustrative placeholder. Write your own content instead of the example in <>`,
    meetingLanguage: "The werewolf meeting message is not in English. Keep the content unchanged and translate it into English as is",
  },
};

export function text(language) {
  return TEXT[language] || TEXT.ja;
}

export function outputRules(language, { hasThought = false } = {}) {
  const t = text(language);
  const labels = ROLE_LABELS_BY_LANGUAGE[language] || ROLE_LABELS_BY_LANGUAGE.ja;
  const vocabulary = language === "en"
    ? Object.values(labels).join(" / ")
    : Object.entries(labels).map(([id, label]) => `${label}=${id}`).join(" / ");
  // private_thought を持たない呼び出しにこの規則を載せると、存在しないフィールドを指すことになる。
  const rules = [...t.outputRules.slice(0, 3), ...(hasThought ? [t.thoughtRule] : []), ...t.outputRules.slice(3)];
  return [t.outputRulesHeader, ...rules, t.vocabulary(vocabulary), t.noOtherRoles].join("\n");
}

/** 検査が投げる、モデルへそのまま返せる却下理由。 */
export class ValidationError extends Error {}
