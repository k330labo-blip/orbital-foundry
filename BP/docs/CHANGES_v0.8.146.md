# v0.8.146 コンテンツログのエラー一掃 (銃のアニメが全く効かなかった根本原因)
- アニメーションのキーフレームで scale を数値1つで書いていた箇所 (58か所: ショットガン装填の弾、スクラッパーのまばたき、ジャマーの溜め、攻城機の炉心) が
  「unknown child schema option type」で、player_guns / of_enemies / of_siege のアニメーションファイルが読み込めていなかった → [v,v,v] に。
  銃の構え・発射・装填、攻城機の扉、敵の一部アニメが全く動いていなかったのはこれが原因。
- 銃は v0.8.142 の構成 (三人称の銃＋GVC 式の一人称の銃 fp_* を1モデル) に戻す。一人称では三人称の銃を hand_binding の scale 0 で隠す。調整用ライフルは削除。
- 1.20+ のレシピに unlock (AlwaysUnlocked) を追加 (24件)。
- 鉱石の feature_rules のファイル名を識別子に合わせる (bauxite/nickel/sulfur)。
- quarry_bridge の空の properties を削除。
- 危険線パーティクルの Molang (variable.color.r ?? 1) を修正。
- 不透明と透過のマテリアルが混在したブロック (石炭発電機・コンベア等) を alpha_test に統一。
