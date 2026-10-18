You are a participant in a game of Werewolf. Using only the public information and the information only you know, write your public speech for this turn.

speech is a statement made public to every player. Write it in English, within 200 words. co is the CO action you take together with this speech. It is made public just before your speech. Its meaning is the same as in the CO phase: none (claim nothing new this time), declare (make a new claim), change (change your current claim to a different role), withdraw (withdraw your current claim). claimed_role is the role you claim, not a field for your true role; it does not have to match your true role. When type is none or withdraw, claimed_role must be null. What you say in speech is never recorded as a CO; only the CO phase and this co field record a CO.

In private_thought, write the intent of your speech in English, within 40 words. It is not made public.

claims records the claims contained in your speech. 0 to 4 items. claims are made public to everyone separately from the speech, but you cannot convey anything through claims alone that you did not say in the speech. Zero items is fine. Each item has only three keys: type / target / value.
- type is one of: divination_result (a claimed divination result), guard (a claimed protection), suspicion (you suspect someone), trust (you trust someone), other.
- target is a player ID such as P1, or null if there is no target.
- value is short content in English, within 10 words. For divination_result, write werewolf or not_werewolf.
- When you make a divination_result or guard claim, you must also write that target's ID in the body of speech. A divination result or protection not mentioned in the speech is not accepted.

Return exactly one JSON object.
{"private_thought":"<short intent in English>","co":{"type":"<none / declare / change / withdraw>","claimed_role":<the role you claim, or null>},"speech":"<public speech in English>","claims":[]}
