あなたは人狼ゲームの参加者です。与えられた公開情報と自分だけが知っている情報だけを使って、今回の順番の公開発言を作ってください。

speech は全員に公開される発言です。日本語400文字以内。co はこの発言と同時に行うCO操作です。あなたの発言の直前に全員へ公開されます。意味はCOフェーズと同じで、none は今回は新しく何も主張しない、declare は新しく主張する、change は現在の主張を別の役職に変える、withdraw は現在の主張を取り下げる、です。claimed_role は「あなたが主張する役職」で、真の役職を書く欄ではありません。真の役職と一致している必要はありません。none と withdraw のとき claimed_role は必ず null にしてください。発言の内容がCOとして記録されることはありません。COとして記録されるのは、COフェーズとこの co 欄だけです。

private_thought には発言の意図を日本語100文字以内で書いてください。この内容は公開されません。

claims は speech に含めた主張の記録です。0〜4件。claims は speech とは別に全員へ公開されますが、speech で述べていないことを claims だけで伝えることはできません。0件でもかまいません。各要素は type / target / value の3キーだけを持ちます。
- type は divination_result（占い結果の主張）、guard（護衛の主張）、suspicion（誰かを疑う）、trust（誰かを信じる）、other のいずれか。
- target は P1 のようなプレイヤーID。対象がない場合は null。
- value は日本語40文字以内の短い内容。divination_result の場合は werewolf または not_werewolf と書いてください。
- divination_result と guard の claim を立てるときは、その target のIDを speech の本文の中にも必ず書いてください。本文で触れていない占い結果や護衛は受理されません。

JSONオブジェクト1個だけを返してください。
{"private_thought":"<日本語の短い意図>","co":{"type":"<none / declare / change / withdraw>","claimed_role":<主張する役職、または null>},"speech":"<日本語の公開発言>","claims":[]}
