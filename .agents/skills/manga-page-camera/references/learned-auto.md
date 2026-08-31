<!-- このファイルは harness-learn が自動で書きます。手で編集しないでください。 -->

# 自動で積み上がった指摘

隣の `SKILL.md` が正本で、**矛盾したときは SKILL.md が優先**します。
ここは運用上の補助指示であって、**監査・承認・合否の証跡には使えません**。

- **発話中の証拠説明に85mm手元マクロを割り当てると、発話者の識別可能な顔を同時に求める契約と衝突し、生成が通常二人ショットへ逃げてQA再試行を消費する。発話台詞ではoverhead-workbenchだけでなくmacro-handsも避け、顔と証拠物を両立できるcounter-level-objectへ置換する。**
  - 根拠: manga-approved-eight-canary-004 image:cut-03-u02: 重複腕を直した再生成でも構図契約の矛盾によりscore 86/fail。lib/mangaSceneComposition.mjs v7へ変更し関連41テストpass。
  - 種別: fact / 初回: 2026-08-31 / id: `f7c8baefc7cc`
- **指定キャストが3人以上のビートにtwo-shot、single、listener-reaction、hands-only等の構図を割り当てると、全員表示の人数契約とカメラ契約が両立せずQAが不必要に失敗する。3人は三角配置、4人は奥行きのあるstaggered groupへ変換し、全員のidentityと発話者を画面内で読めるようにする。**
  - 根拠: manga-approved-eight-canary-004 image:cut-07-u02: exact 3 castにintimate-side-two-shotが割り当てられscore 84/fail。lib/mangaScriptImagePipeline.mjs v7でmulti-cast safe overrideを追加し関連42テストpass。
  - 種別: fact / 初回: 2026-08-31 / id: `fbd19cce7f6e`
- **ロケーション整合性QAが全ての寄り画に全ての常設物を要求すると、接写・ミディアムクローズのカメラ契約と衝突する。引き画は複数の会場要素、寄り画は自然に残る一貫した手掛かりを少なくとも1つ要求し、全設備を見せるために画角を広げない。**
  - 根拠: 画像QA実測: negative-space-profileの接写に椅子列・舞台・受付机・端末・封印箱を全て要求してscore 76/fail。mangaImageQaVisualPromptへshot-scale interpretationを追加し関連45テストpass。
  - 種別: fact / 初回: 2026-08-31 / id: `8fef50772caa`

_最終更新: 2026-08-31T17:01:41.872Z_
