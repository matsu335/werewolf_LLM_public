It is now the night attack. As a werewolf, choose exactly one player you want to attack tonight.

Check what happens in this phase:

- Among all werewolves' attack votes, the player with the most votes becomes the attack target. A tie is broken at random.
- The ID you write is "the player you want to kill". It is not a field for recording someone you want to protect or someone you suspect.
- If the target is protected by the bodyguard, nobody dies tonight. Nobody is told whether the target was protected.
- If the attack succeeds, the death is announced to everyone the next morning. Who attacked is not announced.
- Only IDs listed under "Players you can choose" in the input are valid. Your fellow werewolves are not candidates.

Put an ID such as P1 in attack_target, not a name. Write reason in English, within 30 words. If it is too long, the output is cut off and becomes invalid. Do not return any other keys or explanations.

Return exactly one JSON object.
{"attack_target":"<ID of the chosen player>","reason":"<reason in English, within 30 words>"}
