<!-- このファイルは harness-learn が自動で書きます。手で編集しないでください。 -->

# 自動で積み上がった指摘

隣の `SKILL.md` が正本で、**矛盾したときは SKILL.md が優先**します。
ここは運用上の補助指示であって、**監査・承認・合否の証跡には使えません**。

- **Codex built-in imagegenのreferenced_image_pathsは1呼び出し最大5パス。漫画シーンではlocationを1枠予約し、同時に可視化する固定キャラは最大4人に抑え、各人のidentity-faceをsecondary referenceより先に必ず入れる。5人以上のcutは有料生成前にfail closedし、台本またはcutを分割する。**（2回指摘）
  - 根拠: 2026-08-31 thread 01a057eb-f048-7dc3-996f-8705c8c879b4 session JSONL ordinal 16: referenced_image_paths 7件で ; 5件へ手動縮退後にimagegen開始。lib/mangaScriptImagePipeline.mjsを上限5・overfull hard failへ修正し29 tests pass.
  - 根拠: 2026-08-31 thread 01a057eb-f048-7dc3-996f-8705c8c879b4 session JSONL ordinal 16: referenced_image_paths 7件で must contain at most 5 paths と失敗。5件へ縮退後にimagegen開始。lib/mangaScriptImagePipeline.mjsを上限5・overfull hard failへ修正し29 tests pass。
  - 種別: fact / 初回: 2026-08-31 / id: `0e71978746a3`
- **台本から固定キャストを検出できないことを、番組ルールの免除として扱わない。どのハーネスを使うかは上位のルーターが決めることなので、キャスト未検出は免除ではなく失敗にする**
  - 根拠: lib/koyaChannelGovernance.mjs で、話者名の表記ゆれひとつで18の番組ルールが全部無効化される状態だった（Codex g1レビュー項目16）
  - 種別: correction / 初回: 2026-08-28 / id: `e4bfed5416e8`
- **漫画動画の固定キャラ衣装には『<引用 197fcb20ef0e>』という区分は存在しない（1カット数秒ホールドのため服は必ず目立つ）。台本上ベース服が不適切なシーン（プール→水着等）は、シーンごとの逐次承認ではなく、plan段階で全シーン×固定キャラの服装適合を一括照合→不適合スロットを一括候補生成→1話1回の承認パケットで番号選択→SHA凍結してワードローブ蓄積、が正しいゲート形（wardrobe-readiness）。承認済み服の再登場は凍結シート参照のみ。例外はモブ・エキストラのみ都度生成。**
  - 根拠: 2026-08-30ユーザー訂正（『<引用 23c2860caf39>』『<引用 a2606668fe5a>』）。設計記録: channel-packs/koya/docs/koya-client-reply-2026-08-30.md 長期ワードローブ設計の節
  - 種別: correction / 初回: 2026-08-30 / id: `963ccdec443e`
- **設定画19枚バッチの人手検品で見つかった6件のNGのうち、機械検出へ昇格できるものが2型ある: ①背景混入（白背景標準のシートにシーン背景が出る）はシート外周の白色率チェックで検出可能 ②3/4ビューの向き重複（左右2セルが同方向）は片方を左右反転したpHash同士の距離で検出可能。また③衣装シート生成は承認元シートを衣装の正参照として必ず画像で渡す（『<引用 4ac57233d899>』等の一般語記述だと別の服に変質する。実例: <private-term>OLがカーディガン→ブレザー化）。①②は character-attribute-gate への追加候補、③はプロンプト規則。**
  - 根拠: canvas/character-reviews/setting-sheet-human-qa-findings-2026-08-30.json のfindings 6件（ema-outfit-office-wrong-garment-and-background / <private-term>-expressions-background-contamination / ema-turnaround-duplicate-34-direction ほか）
  - 種別: fact / 初回: 2026-08-30 / id: `bfccffc4ae54`
- **画像生成の機械QAは、構図や描画品質が高くても、台本の小規模な地域催事場を高級ホテルのロビーへ置換した意味ずれを通過させることがある。台本由来の会場種別・規模・設備・明示的な禁止例を、背景参照と全シーンの生成プロンプトだけでなくブラインドQAのハード失敗条件にも同一契約として渡し、代表画像を人間が知覚確認する。**
  - 根拠: manga-approved-eight-canary-002 の reference-environment-primary-location.png と cut-03-u01.png を実見。台本は番組固有の町の商店会が開く小さな催事場だが、生成物は大理石床・コンシェルジュ台・都市眺望を備えた高級ホテルロビーで、旧QAは合格。lib/mangaScriptImagePipeline.mjs の setting fidelity contract と回帰テストで対処。
  - 種別: fact / 初回: 2026-08-31 / id: `86a0f746b4e5`
- **複数話者を含む同一カットでは、cut-level castNames の先頭を各utteranceの話者として扱ってはいけない。各画像ジョブにutterance由来のactiveSpeakerIdとactiveSpeakerNameを保存し、生成プロンプトとブラインドQAの両方でその人物を発話者として固定する。聞き手だけが発話中に見える画像はハード失敗にする。**
  - 根拠: 2人会話カットの2行目で、旧QAがcastNames[0]の1人目を発話者と誤認し、再生成画像でも聞き手側の口だけが開いた。lib/mangaScriptImagePipeline.mjs と test/mangaScriptImagePipeline.test.mjs で修正し、回帰テスト31件合格。
  - 種別: fact / 初回: 2026-08-31 / id: `7009e9e5c53f`
- **公開施設・職場・街路という場所カテゴリだけを根拠に背景モブを許可してはいけない。背景人物はその正確なbeatが群衆・同級生・同僚・来場者などを明示した場合だけ許可し、承認キャラの複製や同一identityの反復は生成プロンプトとブラインドQAのハード失敗にする。**
  - 根拠: 開場前の2人対決カットで、公共の催事場という理由だけから複数の背景人物と承認キャラの複製が生成された。lib/mangaSceneComposition.mjs、lib/mangaScriptImagePipeline.mjsと回帰テスト39件で対処。
  - 種別: fact / 初回: 2026-08-31 / id: `e722b47c28f8`
- **複数人物のscene-image参照は、人物ごとの全参照を単純連結してslice(0,8)してはいけない。後方の人物が0枚になるため、まず画面内の全人物へidentity anchorを1枚ずつ配り、残枠だけ追加参照と背景へ割り当てる。**
  - 根拠: manga-approved-eight-canary-001のplan実測。cut-12は<private-term>・（固定キャストの1人）・（固定キャストの1人）の参照で8枠を使い、台本にいる（固定キャストの1人）の参照が0枚。lib/mangaScriptImagePipeline.mjsのunique([...characterRefs,...locationRefs]).slice(0,8)が原因。
  - 種別: fact / 初回: 2026-08-31 / id: `1e781555b959`

_最終更新: 2026-08-31T17:01:41.872Z_
