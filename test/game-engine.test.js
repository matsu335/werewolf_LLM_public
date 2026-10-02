import test from "node:test";
import assert from "node:assert/strict";
import { GameEngine, GameRuleError } from "../src/domain/game-engine.js";
import { defaultConfig, validateConfig } from "../src/domain/config.js";
import { CONTROLLERS, MAX_PLAYERS, ROLES, VISIBILITIES } from "../src/domain/constants.js";

function configWithRoles(roles, seed = 123) {
  const roleCounts = Object.fromEntries(Object.values(ROLES).map((role) => [role, 0]));
  roles.forEach((role) => roleCounts[role] += 1);
  return {
    ...defaultConfig(), seed, roleCounts,
    players: roles.map((role, i) => ({
      id: `P${i + 1}`, name: `P${i + 1}`, controller: CONTROLLERS.HUMAN,
      fixedRole: role, llm: null,
    })),
  };
}

test("partial fixed role assignment preserves counts and is reproducible", () => {
  const config = defaultConfig();
  config.seed = 42;
  config.players[0].fixedRole = ROLES.WEREWOLF;
  const a = new GameEngine(config).start();
  const b = new GameEngine(config).start();
  const rolesA = Object.values(a.state.players).map((p) => p.role);
  const rolesB = Object.values(b.state.players).map((p) => p.role);
  assert.deepEqual(rolesA, rolesB);
  assert.equal(a.state.players.P1.role, ROLES.WEREWOLF);
  for (const [role, count] of Object.entries(config.roleCounts)) assert.equal(rolesA.filter((r) => r === role).length, count);
});

test("zero-wolf special composition ends immediately with village win", () => {
  const engine = new GameEngine(configWithRoles([ROLES.VILLAGER, ROLES.MADMAN]));
  engine.start();
  assert.equal(engine.state.status, "finished");
  assert.equal(engine.state.winner, "village");
});

test("madman counts as human for parity but wins with wolves", () => {
  const engine = new GameEngine(configWithRoles([ROLES.WEREWOLF, ROLES.MADMAN, ROLES.VILLAGER]));
  engine.start();
  assert.equal(engine.state.status, "running");
  engine.submitVote("P1", "P3");
  engine.submitVote("P2", "P3");
  engine.submitVote("P3", "P3");
  engine.resolveVotes();
  assert.equal(engine.state.winner, "wolf");
});

test("self vote is valid and only public tally is exposed", () => {
  const engine = new GameEngine(configWithRoles([ROLES.WEREWOLF, ROLES.VILLAGER, ROLES.VILLAGER]));
  engine.start();
  engine.submitVote("P1", "P1");
  engine.submitVote("P2", "P1");
  engine.submitVote("P3", "P2");
  const result = engine.resolveVotes();
  assert.equal(result.executed, "P1");
  const publicEvents = engine.publicView().events;
  assert.equal(publicEvents.some((e) => e.type === "vote_cast"), false);
  assert.equal(publicEvents.some((e) => e.type === "vote_result"), true);
});

test("guard prevents attack and consecutive guard is rejected", () => {
  const engine = new GameEngine(configWithRoles([ROLES.WEREWOLF, ROLES.BODYGUARD, ROLES.SEER, ROLES.VILLAGER]));
  engine.start();
  engine.submitAttackVote("P1", "P3");
  engine.submitGuard("P2", "P3");
  engine.submitDivination("P3", "P1");
  const result = engine.resolveNight();
  assert.deepEqual(result.deaths, []);
  assert.equal(engine.player("P3").privateInfo.divinations.at(-1).result, "werewolf");
  // 護衛で夜が空振りしたことは誰にも公開されないが、観測者が夜の因果を追えないと実験にならない。
  const outcome = engine.events.findLast((e) => e.type === "attack_outcome");
  assert.equal(outcome.visibility, VISIBILITIES.SECRET);
  assert.deepEqual({ ...outcome.payload, day: undefined }, { targetId: "P3", blocked: true, guardedBy: "P2", day: undefined });
  assert.ok(!engine.publicView().events.some((e) => e.type === "attack_outcome"));
  engine.submitAttackVote("P1", "P4");
  assert.throws(() => engine.submitGuard("P2", "P3"), GameRuleError);
});

test("the default village is five players with one of each role and English as the LLM language", () => {
  const config = defaultConfig();
  assert.equal(config.players.length, 5);
  assert.deepEqual(config.roleCounts, { werewolf: 1, madman: 1, seer: 1, bodyguard: 1, villager: 1 });
  assert.equal(config.language, "en");
  assert.match(config.name, /5人/);
  assert.deepEqual(validateConfig(config), []);
});

test("a room holds at most nine players", () => {
  const config = defaultConfig();
  config.players = Array.from({ length: MAX_PLAYERS + 1 }, (_, i) => ({ ...config.players[0], id: `P${i + 1}` }));
  config.roleCounts = { werewolf: 2, madman: 1, seer: 1, bodyguard: 1, villager: MAX_PLAYERS - 4 };
  assert.ok(validateConfig(config).some((error) => /最大9人/.test(error)));
});

test("day one has stable two-round order and later order starts after night victim", () => {
  const engine = new GameEngine(configWithRoles([ROLES.WEREWOLF, ROLES.VILLAGER, ROLES.VILLAGER, ROLES.VILLAGER], 9));
  engine.start();
  const day1 = engine.createDiscussionOrder();
  assert.deepEqual(engine.state.discussionOrder, day1);
  engine.state.day = 2;
  const victim = day1[1];
  engine.player(victim).alive = false;
  engine.state.nightDeaths = [victim];
  const order = engine.createDiscussionOrder();
  const victimSeat = engine.player(victim).seat;
  const expected = engine.state.seatOrder.slice(victimSeat + 1).concat(engine.state.seatOrder.slice(0, victimSeat)).find((id) => engine.player(id).alive);
  assert.equal(order[0], expected);
});
