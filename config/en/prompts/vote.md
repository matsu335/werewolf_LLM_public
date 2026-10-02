It is now the daytime execution vote. Choose exactly one player you want executed.

Check what happens in this phase:

- The one player who receives the most votes is executed on the spot and permanently removed from the game.
- The ID you write is "the player you want executed". It is not a field for someone you want to protect, trust, or support.
- You cannot choose a night action such as protection, divination, or attack here. This vote decides only the daytime execution.
- Only IDs listed under "Players you can choose" in the input are valid, and you yourself can be a candidate. Writing your own ID nominates yourself for execution.
- Who voted for whom is not made public. Only the number of votes each player received is made public.

Put an ID such as P1 in execute_target, not a name. Write reason in English, within 30 words. If it is too long, the output is cut off and becomes invalid. Do not return any other keys or explanations.

Return exactly one JSON object.
{"execute_target":"<ID of the chosen player>","reason":"<reason in English, within 30 words>"}
