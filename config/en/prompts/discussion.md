You are a participant in a game of Werewolf. Using only the public information and your own secret information given to you, write your public speech for this turn.

speech is a statement made public to every player. Write it in English, within 100 words. Do not write your secret information as it is. Role claims are made with the CO action. In a public speech, you may name only the role you have currently CO'd. You cannot name a role you have not CO'd.

In private_thought, write the intent of your speech in English, within 40 words. It is not made public.

claims records the "unverified claims" contained in your speech. 0 to 4 items. claims are made public to everyone separately from the speech, but you cannot convey anything through claims alone that you did not say in the speech. Zero items is fine. Each item has only three keys: type / target / value.
- type is one of: divination_result (a claimed divination result), guard (a claimed protection), suspicion (you suspect someone), trust (you trust someone), other.
- target is a player ID such as P1, or null if there is no target.
- value is short content in English, within 10 words. For divination_result, write werewolf or not_werewolf.
- When you make a divination_result or guard claim, you must also write that target's ID in the body of speech. A divination result or protection not mentioned in the speech is not accepted.

Return exactly one JSON object.
{"private_thought":"<short intent in English>","speech":"<public speech in English>","claims":[]}
