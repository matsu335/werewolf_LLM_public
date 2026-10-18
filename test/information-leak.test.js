import test from "node:test";
import assert from "node:assert/strict";
import { GameEngine } from "../src/domain/game-engine.js";
import { defaultConfig } from "../src/domain/config.js";
import { CONTROLLERS, ROLES, VISIBILITIES } from "../src/domain/constants.js";
import { TARGET_KEYS, salvageSpeech, validateCo, validateDiscussion, validateMeeting, validateTarget } from "../src/app/game-session.js";
import { normalizeRoleId, violatesLanguage } from "../src/domain/text-rules.js";

function configWithRoles(roles, seed = 123) {
  const roleCounts = Object.fromEntries(Object.values(ROLES).map((role) => [role, 0]));
  roles.forEach((role) => roleCounts[role] += 1);
  return {
    ...defaultConfig(), seed, roleCounts,
    players: roles.map((role, i) => ({
      id: `P${i + 1}`, name: `P${i + 1}`, controller: CONTROLLERS.HUMAN, fixedRole: role, llm: null,
    })),
  };
}

const ja = (overrides = {}) => ({ role: ROLES.VILLAGER, partners: [], validTargets: ["P1", "P2", "P3"], currentCo: null, language: "ja", ...overrides });
const en = (overrides = {}) => ja({ language: "en", ...overrides });

test("a no-action CO never leaks the role name it was called with", () => {
  const engine = new GameEngine(configWithRoles([ROLES.WEREWOLF, ROLES.VILLAGER, ROLES.VILLAGER]));
  engine.start();
  const record = engine.applyCo("P1", { type: "none", role: ROLES.WEREWOLF });
  assert.equal(record.claimedRole, null);
  assert.equal(engine.player("P1").currentCo, null);
  const coEvents = engine.events.filter((event) => event.type === "co");
  assert.equal(coEvents.length, 0);
  const leaking = engine.events.filter((event) => event.visibility === VISIBILITIES.PUBLIC && JSON.stringify(event.payload).includes(ROLES.WEREWOLF));
  assert.deepEqual(leaking, []);
});

test("speech no longer carries a CO operation at all", () => {
  const engine = new GameEngine(configWithRoles([ROLES.WEREWOLF, ROLES.VILLAGER, ROLES.VILLAGER]));
  engine.start();
  engine.recordSpeech("P1", { speech: "P2が気になる", claims: [] });
  const speech = engine.events.find((event) => event.type === "speech");
  assert.equal(Object.hasOwn(speech.payload, "coAction"), false);
  assert.equal(JSON.stringify(speech.payload).includes(ROLES.WEREWOLF), false);
});

test("change without an existing CO is recorded as a plain declare", () => {
  const engine = new GameEngine(configWithRoles([ROLES.WEREWOLF, ROLES.VILLAGER, ROLES.VILLAGER]));
  engine.start();
  const record = engine.applyCo("P2", { type: "change", role: ROLES.SEER });
  assert.equal(record.type, "declare");
  assert.equal(record.before, null);
  assert.equal(engine.player("P2").currentCo, ROLES.SEER);
});

test("the LLM view excludes operational telemetry and raw event noise", () => {
  const engine = new GameEngine(configWithRoles([ROLES.WEREWOLF, ROLES.SEER, ROLES.VILLAGER, ROLES.VILLAGER]));
  engine.start();
  engine.emit("llm_status", { playerId: "P1", callType: "attack", status: "success" }, VISIBILITIES.SYSTEM);
  engine.recordSpeech("P3", { speech: "様子を見たい", claims: [] });
  const brief = JSON.stringify(engine.publicBrief());
  assert.equal(brief.includes("llm_status"), false);
  assert.equal(brief.includes("attack"), false);
  assert.equal(brief.includes("role_assigned"), false);
  assert.ok(brief.includes("様子を見たい"), "発言が公開ビューに入っていない");
  // 参加者向けビューにもsystemイベントは出さない（callTypeから夜の役職行動が割れる）。
  assert.equal(engine.publicView().events.some((event) => event.type === "llm_status"), false);
});

test("every public speech from day one onward stays in full, in the order it happened", () => {
  const engine = new GameEngine(configWithRoles([ROLES.WEREWOLF, ROLES.SEER, ROLES.VILLAGER, ROLES.VILLAGER]));
  engine.start();
  engine.recordSpeech("P3", { speech: "1日目の発言", claims: [] });
  engine.state.day = 4;
  engine.recordSpeech("P4", { speech: "4日目の発言", claims: [] });
  const speeches = engine.publicBrief().record.filter((row) => row.type === "speech");
  // 古い日を要約に落とすと、モデルの視界が黙って削られる。
  assert.deepEqual(speeches.map((row) => [row.day, row.speech]), [[1, "1日目の発言"], [4, "4日目の発言"]]);
});

test("a CO is recorded only from the co field of the speech, never guessed from the speech text", () => {
  const declared = validateDiscussion({ co: { type: "declare", claimed_role: "seer" }, speech: "I am the seer. P2 is not a werewolf." }, en({ role: ROLES.SEER }));
  assert.deepEqual(declared.co, { type: "declare", role: ROLES.SEER });
  // 本文の名乗りは検査も推測もしない。引用・否定・嘘の名乗りも、そのまま発言として残る。
  const quoted = validateDiscussion({ co: { type: "none", claimed_role: null }, speech: "As the seer, I divined P1. P3's claim that I am a werewolf is false." }, en({ role: ROLES.SEER, currentCo: ROLES.SEER }));
  assert.deepEqual(quoted.co, { type: "none", role: null });
  assert.equal(quoted.speech, "As the seer, I divined P1. P3's claim that I am a werewolf is false.");
  assert.equal(validateDiscussion({ speech: "私は狩人です。" }, ja({ currentCo: ROLES.SEER })).co.type, "none");
  // 発言と同時のCO変更もCOフェーズと同じ規則で扱う。
  assert.deepEqual(validateDiscussion({ co: { type: "change", claimed_role: "bodyguard" }, speech: "私は狩人です。" }, ja({ currentCo: ROLES.SEER })).co, { type: "change", role: ROLES.BODYGUARD });
  assert.throws(() => validateDiscussion({ co: { type: "declare", claimed_role: "mayor" }, speech: "I am the mayor." }, en()));
  // 最終手段では、読めないCOは「何もしない」にし、発言は残す。
  const salvaged = salvageSpeech({ co: { type: "declare", claimed_role: "mayor" }, speech: "I am the madman. Anyway, P2 has been quiet." }, en({ role: ROLES.MADMAN }));
  assert.deepEqual(salvaged.co, { type: "none", role: null });
  assert.equal(salvaged.speech, "I am the madman. Anyway, P2 has been quiet.");
});

test("a fellow werewolf's identity is still kept out of public speech", () => {
  const context = ja({ role: ROLES.WEREWOLF, partners: ["P5"], validTargets: ["P1", "P5"] });
  assert.equal(validateDiscussion({ speech: "私はP1が人狼だと思います。" }, context).speech, "私はP1が人狼だと思います。");
  assert.throws(() => validateDiscussion({ speech: "P5は私の仲間なので信用できます。" }, context), /秘密情報/);
  const wolf = en({ role: ROLES.WEREWOLF, partners: ["P5"], validTargets: ["P1", "P5"] });
  assert.throws(() => validateDiscussion({ speech: "P5 is my partner, trust them." }, wolf), /secret information/);
  assert.equal(validateDiscussion({ speech: "I trust P5 more than P1." }, wolf).speech, "I trust P5 more than P1.");
});

test("an empty speech or one in the wrong language is rejected so it can be regenerated, not blanked", () => {
  assert.throws(() => validateDiscussion({ speech: "" }, ja()), /空/);
  assert.throws(() => validateDiscussion({ speech: "P8 is a werewolf, we should lynch them." }, ja()), /日本語/);
  // 英語の試合では、日本語・中国語の混入を差し戻す。qwen3は思考中に中国語を混ぜる。
  assert.throws(() => validateDiscussion({ speech: "P8 is suspicious 阵营." }, en()), /not in English/);
  assert.equal(violatesLanguage("P8 is suspicious.", "en"), false);
  assert.throws(() => validateMeeting({ message: "P3を噛もう" }, "en"), /not in English/);
  // 最終手段でも空にはしない。空発言は「黙っている＝怪しい」という偽の材料を生む。
  assert.ok(salvageSpeech({ speech: "" }, ja()).speech.length > 0);
  assert.match(salvageSpeech({ speech: "" }, en()).speech, /^I /);
});

test("claims are coerced into the fixed schema and unknown targets are dropped", () => {
  const context = ja({ role: ROLES.SEER, validTargets: ["P1", "P2"] });
  const result = validateDiscussion({
    speech: "P2について共有したいことがあります。",
    claims: [
      { type: "divination_result", target: "P2", value: "not_werewolf" },
      { type: "魔女の予言", target: "P9", claim: "怪しい" },
      { target: null, value: "" },
    ],
  }, context);
  assert.deepEqual(result.claims, [
    { type: "divination_result", target: "P2", value: "not_werewolf" },
    { type: "other", target: null, value: "怪しい" },
  ]);
});

test("a claim cannot smuggle a divination result that the public speech never mentioned", () => {
  const context = ja({ role: ROLES.SEER, validTargets: ["P1", "P4"] });
  // 実ログで起きた形。発言では占い結果に触れず、claimだけでP4の白を全員に配っていた。
  assert.throws(() => validateDiscussion({
    speech: "占い結果は夜にのみ分かるので、いまは慎重に話を聞きたいです。",
    claims: [{ type: "divination_result", target: "P4", value: "not_werewolf" }],
  }, context), /公開発言の本文/);
  const tethered = validateDiscussion({
    speech: "P4を占った結果を共有します。P4は人狼ではありませんでした。",
    claims: [{ type: "divination_result", target: "P4", value: "白" }],
  }, context);
  // 表記が揺れても同じ主張として追えるように二値へ揃える。真偽は判定しない。
  assert.deepEqual(tethered.claims, [{ type: "divination_result", target: "P4", value: "not_werewolf" }]);
  const english = validateDiscussion({
    speech: "I checked P4 and P1.",
    claims: [{ type: "divination_result", target: "P4", value: "not a werewolf" }, { type: "divination_result", target: "P1", value: "Werewolf" }],
  }, en({ role: ROLES.SEER, validTargets: ["P1", "P4"] }));
  assert.deepEqual(english.claims.map((c) => c.value), ["not_werewolf", "werewolf"]);
  // 疑い・信頼は意見であって役職由来の情報ではないので、本文との対応までは要求しない。
  assert.equal(validateDiscussion({
    speech: "まだ判断材料が足りないと感じています。",
    claims: [{ type: "suspicion", target: "P1", value: "反応が薄い" }],
  }, context).claims.length, 1);
  // 差し戻しても最後はfallbackが通るので、そこでも裏口を残さない。
  assert.deepEqual(salvageSpeech({
    speech: "いまは慎重に話を聞きたいです。",
    claims: [{ type: "divination_result", target: "P4", value: "not_werewolf" }, { type: "suspicion", target: "P1", value: "反応が薄い" }],
  }, context).claims, [{ type: "suspicion", target: "P1", value: "反応が薄い" }]);
});

test("a vote cannot be filled in as if it were a night action", () => {
  const living = ["P1", "P4", "P7"];
  // 実ログで起きた形。狩人が処刑投票に護衛先を書き、白先のP4へ村の票が集まって処刑された。
  assert.throws(() => validateTarget({ guard_target: "P4", reason: "守りたい" }, living, TARGET_KEYS.vote), /昼の処刑投票/);
  assert.throws(() => validateTarget({ execute_target: "P4", reason: "吊りたい" }, living, TARGET_KEYS.guard), /夜の護衛/);
  assert.equal(validateTarget({ execute_target: "P4", reason: "吊りたい" }, living, TARGET_KEYS.vote).target, "P4");
  assert.equal(validateTarget({ guard_target: "P4", reason: "守りたい" }, living, TARGET_KEYS.guard).target, "P4");
});

test("a rejected target names the candidates, and a copied placeholder is sent back", () => {
  // 候補を示さずに却下したとき、モデルは「候補が与えられていない」と推論してプロンプトの例示を写した。
  assert.throws(() => validateTarget({ execute_target: "P1", reason: "x" }, ["P2", "P3"], TARGET_KEYS.vote), /P2, P3 のいずれか/);
  assert.throws(() => validateTarget({ execute_target: "P1", reason: "x" }, ["P2", "P3"], TARGET_KEYS.vote, "en"), /one of P2, P3/);
  assert.throws(() => validateTarget({ execute_target: "P2", reason: "<日本語80文字以内の理由>" }, ["P2"], TARGET_KEYS.vote), /プレースホルダ/);
});

test("CO reads claimed_role, accepts japanese and english labels, and clears the role for none", () => {
  assert.deepEqual(validateCo({ type: "declare", claimed_role: "占い師" }), { type: "declare", role: ROLES.SEER });
  assert.deepEqual(validateCo({ type: "declare", claimed_role: "Seer" }), { type: "declare", role: ROLES.SEER });
  assert.deepEqual(validateCo({ type: "none", claimed_role: "werewolf" }), { type: "none", role: null });
  assert.deepEqual(validateCo({ type: "withdraw", claimed_role: "seer" }, ROLES.SEER), { type: "withdraw", role: null });
  assert.deepEqual(validateCo({ type: "change", claimed_role: "視力者" }), { type: "declare", role: ROLES.SEER });
  assert.equal(normalizeRoleId("警備員"), ROLES.BODYGUARD);
  assert.equal(normalizeRoleId("Fortune Teller"), ROLES.SEER);
  assert.throws(() => validateCo({ type: "declare", claimed_role: "魔女" }), /役職が不正/);
});
