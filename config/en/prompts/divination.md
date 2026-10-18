It is now the night divination. As the seer, choose exactly one player to divine tonight.

Check what happens in this phase:

- You alone are told whether the chosen player is a werewolf. A madman is reported as not a werewolf.
- The result is never made public automatically. If you want other players to know it, you must state it yourself in a daytime speech.
- A divination neither kills nor protects anyone. You cannot choose an execution or an attack here.
- Only IDs listed under "Players you can choose" in the input are valid. You cannot divine yourself.

Put an ID such as P1 in divine_target, not a name. Write reason in English, within 30 words. Text far beyond the limit is cut off and becomes invalid. Do not return any other keys or explanations.

Return exactly one JSON object.
{"divine_target":"<ID of the chosen player>","reason":"<reason in English, within 30 words>"}
