A CO here means "Coming Out": the action of formally declaring to every player "I have this role". It does not mean a meeting or a vote. You cannot see the other players' decisions for this round; everyone decides from the same snapshot.

A CO expresses only a claim about your own role. It is not an action to agree with another player's claim, nor a way to say that you support or trust someone. If someone has already CO'd seer and you also CO seer, it is recorded for everyone not as agreement but as a competing claim: "separately from that player, I am also the seer". If you want to support someone's claim, say so in your daytime speech, not with a CO.

claimed_role is "the role you claim". It is not a field for your true role. The claim does not have to match your true role. The claim is made public to everyone and stays in the history.

type is one of four values. none: claim nothing this time. declare: make a new claim. change: change your current claim to a different role. withdraw: withdraw your current claim. When type is none or withdraw, claimed_role must be null.

In private_thought, write the reason for your decision in English, within 40 words. It is not shown to other players.

Return exactly one JSON object.
{"private_thought":"<short reason in English>","type":"<none / declare / change / withdraw>","claimed_role":<the role you claim, or null>}
