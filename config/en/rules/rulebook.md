# Werewolf for Humans and LLMs: Rulebook

Every player belongs to either the village team or the werewolf team. The village team wins when every werewolf is dead. The werewolf team wins when the number of living werewolves is equal to or greater than the number of living players counted as humans. The madman belongs to the werewolf team, but is counted as a human for this head count.

## Roles in this game and what they can do

The following is common knowledge that every player knows. Who holds which role is secret, but every player knows what each role can do. The number of players holding each role in this game is given under "Role composition" in the input.

- villager (village team): No special night action. Speaks and votes using only public information and reasoning.
- seer (village team): At night, chooses one living player other than themselves and learns, privately, whether that player is "a werewolf" or "not a werewolf". A madman is reported as "not a werewolf". On the first day the seer receives one random result: another player who is not a werewolf.
- bodyguard (village team): At night, protects one living player other than themselves. If the protected player is attacked that night, the attack fails and nobody dies. Nobody, including the bodyguard, is told whether a protection succeeded. The bodyguard cannot protect the same player on two consecutive nights.
- madman (werewolf team): No special night action. Does not know who the werewolves are, and the werewolves cannot tell who the madman is. Counted as a human in the head count that decides the winner.
- werewolf (werewolf team): At night, the werewolves hold a secret meeting among themselves and vote on whom to attack. The player with the most attack votes is attacked; a tie is broken at random. If the attacked player was protected by the bodyguard, nobody dies that night. Werewolves cannot attack a fellow werewolf; they can attack the madman.

Nobody is told who did what at night. The next morning, the only thing announced is whether someone died in an attack. When nobody died, either the bodyguard's protection succeeded or the werewolves could not attack, but nobody is told which.

## The day

During the day, players speak in the given order, and then every living player casts a secret vote. Voting for yourself is allowed. Only the number of votes each candidate received is made public; who voted for whom is not. If the top vote count is tied, one of the tied players is chosen at random and executed. The executed player's role is not revealed. An execution is the result of a majority vote, and at the time of voting nobody knows whether the executed player is a werewolf. The village team gets closer to winning only when it executes a werewolf; executing a village-team player reduces the village team's numbers.

## CO and claims (every claim is self-reported)

A formal role declaration (CO, "coming out") is a dedicated action, separate from what you say in speech. You can CO, CO the same role again, withdraw your CO, or change it to a different role, and the history stays visible to everyone. A CO is only a record that "this player claims to have this role"; the game never checks whether the claim is true. Nobody's CO is guaranteed to match their true role. A player of any role can CO a role different from their true role.

Claims contained in a speech, such as divination results or protections, are recorded as Claims and made public to everyone. Claims are also self-reported. The game never checks whether a Claim is true, and never corrects or denies it. A player who is not the seer can issue a Claim saying "I divined someone and they were a werewolf", and there is no mechanism that shows it to be false. Conversely, if the real seer keeps a result to themselves, that result is never revealed automatically. A Claim that appears in the public information means only the fact that "someone said so", not the fact that "it is so".

A Claim must correspond to what the speech says. You cannot convey a divination result or a protection through a Claim alone without mentioning it in the speech. State the claim in the body of your public speech, naming the target's ID.

Your true role, the night information that only you know, and the identity of your fellow werewolves are all secret information. Do not write secret information in a public speech. To claim a role, you must use the CO action. In a public speech, you may name only the role you have currently CO'd.

Dead players take no further part in speeches, votes, night actions, or any other action.
