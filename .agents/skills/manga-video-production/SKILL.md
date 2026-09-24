---
name: manga-video-production
description: 日本語漫画動画の台本設計、キャラクター、画像、台詞音声、吹き出し、カメラ、レンダー、修復、実MP4監査を行う。漫画動画を新規制作・変更・レビュー・監査するときは常に使い、旧version固有スクリプトを新作へ流用しない。
---


> 作業前に `references/learned-auto.md` を読む。矛盾したときはこの SKILL.md が優先。learned-auto は運用上の補助指示であって、監査・承認・合否の証跡には使えない。
# 漫画動画制作

これはClaude CodeとCodexが共用する正本スキルである。作業開始時に本スキルを使うことを伝え、カメラを扱う場合は`../manga-page-camera/SKILL.md`も最後まで読む。

## 最初に読むもの

変更や有料生成の前に次を最後まで読む。

1. `../../../config/koya-manga-production-contract.json` — 実行可能な既定値と必須監査。全項目は隣接するJSON Schemaで閉じ、未知キーや型崩れを許さない
2. Channel Pack の要求台帳（`channel-packs/<id>/docs/koya-channel-requirements-ledger.md`）— ユーザー要求の時系列。矛盾時は、明示されたエピソード例外を除き、後の要求を優先する
3. `../../../config/koya-manga-episode-overrides/<episode-id>.json` — 存在するときだけ読む凍結済み例外
4. `references/quality-contract-ja.md` — セッション横断で一般化した台本・絵・音声・編集品質
5. `references/final-review-ja.md` — 実MP4の知覚レビューと完了判定
6. `references/source-face-review-ja.md` — 自動顔検出の失敗、実MP4監査で判明した検出漏れ、重要小道具・証拠物の遮蔽を補うhash拘束付き手動領域レビュー
7. `../../../config/koya-manga-quality-incidents.json` — 新しい環境にも配布する一般化済み事故seed。実行時台帳とマージし、強い昇格状態を下げない
8. Channel Pack の show bible（`channel-packs/<id>/config/koya-show-bible.json`。解決は `resolveChannelPackPath`）— 舞台設定、固定キャラの役割・口調、逆転型、最新の承認/保留状態。後日の明示修正が旧PDF指定を上書きする
9. Channel Pack の location bible — 番組の定点となる店舗と町の、人物なし背景ボード仕様。承認画像がないlocationを登録しない
10. Channel Pack の thumbnail contract（解決は `resolveChannelPackPath`）— 専用サムネ画像、中央帯、2/3コマ、文字数・具体名詞制約。pendingの色・書体を推測しない
11. Channel Pack の番組ガバナンス文書（`channel-packs/<id>/docs/koya-channel-governance-ja.md`）— 台本beat review、背景4視点review、サムネpreflight/finalの実行形式

JSON契約が実行設定の正本、要求台帳が理由の正本である。コード・本スキル・契約が食い違う場合は制作を止め、同じ変更内で整合させる。

## 唯一の制作入口

運営者が新規作品を作る入口は、Claude Code / Codexのどちらでも上位Video Harnessだけである。

```bash
# まず署名済みChannel Packを検証し、耐久JobとCanvas Runを作る。有料APIはまだ呼ばない。
node scripts/run-video-harness.mjs start \
  --harness koya-manga-video \
  --script-path /absolute/script.txt \
  --channel-pack /absolute/signed-channel-pack-envelope \
  --episode-id manga-<new-id> \
  --protagonist-speaker-id <話者IDまたは完全一致名>

# Jobのpreflight・人間判断を確認した後だけ、同じJobを実行・再開する。
node scripts/run-video-harness.mjs resume \
  --job-id <startが返したJob ID> \
  --project-dir /absolute/project \
  --confirmed
```

明示的に有料実行まで確認済みなら、最初の`start`へ`--confirmed`を付けてもよい。
上位入口は、署名済みChannel Pack、制作契約の実ファイルSHA、durable Job、doctor、
再開/取消、共通RunReceipt、実MP4全decode、BuzzAssist Canvas投影を一つのidentityへ
拘束する。ホストがMCPを使える場合の`run_video_harness`も同じServiceを呼ぶ同等入口である。

`node scripts/koya-manga-video.mjs`は、上位Jobが検証済みworkspace内で呼ぶ**唯一の内部Koya runner**である。
`plan`、`full`、`speech`、`render`、個別repair/audit actionを直接実行するのは、上位Jobに
紐づいた保守・診断、またはfixture/benchmarkだけに限る。新作を直接`plan/full`で開始して、
上位Job、署名Pack、RunReceipt、Canvasを迂回してはならない。

`scripts/build-manga-video.mjs`の`full`/`speech`、`apply-manga-v*`、`finalize-manga-v*`、
`generate-manga-v*`は新規作品へ使用しない。これらは
`config/koya-manga-legacy-migrations.json`に隔離されたベンチマーク移行である。

内部`full`の終了コード2または3、または上位Jobの`completed`以外は完成ではない。
`run-video-harness.mjs status`でJobを読み、承認待ち・利用上限・失敗箇所から、合格済み
artifactを再生成せず同じJob IDで再開する。

以下に出てくる`koya-manga-video.mjs`の個別actionは、上位Jobに拘束済みのworkspaceを
検査・修復するための内部手順であり、新規制作の入口ではない。

## 品質ゲート（2026-08-28 追加。Claude Code / Codex 共通）

機械で測れるものは人間の目視より先に落とす。実行系はホストに依存しないため、
どちらのホストから起動しても同じ判定になる。

### 音声（台帳R194〜R195、R197、R199）

`speech`と`full`では音声品質ゲートが**既定でON**である。無効化するには
理由の明示が要る。

```bash
node scripts/koya-manga-video.mjs speech --episode-id <id>
# 無効化する場合のみ（監査に残る）
node scripts/koya-manga-video.mjs speech --episode-id <id> \
  --no-voice-quality-gate --voice-quality-gate-override-reason "<理由>"
```

- hard failのテイクは選定の適格集合から除外される。全滅時は最大4テイクまで
  自動追加し、それでも全滅ならカットを停止して人間へ渡す。
- 必須メトリクス（UTMOS、全発話のCER）が測れなかったテイクもhard failとする。
  測れなかったものをpassにしない。
- Python実行系は`VOICE_QA_PYTHON`（既定`/usr/bin/python3`）で固定する。
  `python3`はホストや起動経路によって解決先が変わり、依存の無い実行系を引くと
  ゲートが黙って無効になる。
- 手順の詳細は`docs/koya-voice-quality-runbook-ja.md`。

### キャラクター（台帳R192、R196、R200）

候補・修正画像は人間の目視の前に属性ゲートを通す。

```bash
node scripts/koya-manga-video.mjs character-attribute-gate \
  --inventory-path canvas/attribute-gates/<cast>-<round>.json
```

- 髪色Δ、微差テイク（pHash）、意図外変更、装飾スクリーニング、目の左右（人手）。
- 被覆はasset単位で、別assetの同型チェックで代替できない。必須ゲートが1件でも
  未実行なら不合格。
- 目の左右は機械判定できないため、reviewer名付きのアテステーションが要る。
- 実行系は`KOYA_GATE_PYTHON`（既定`/usr/bin/python3`）。
- 不合格からのやり直しは`lib/characterRepairPlan.mjs`のrepair-planを作ってから。
  修正ROIが次ラウンドの許可領域になり、それ以外の変化は落とされる。
- 手順の詳細は`docs/koya-character-gate-runbook-ja.md`。

### 匿名比較（台帳R198）

人間が選ぶ場面では出所を伏せる。

```bash
# 公式blind packetを見る（閲覧用）
node scripts/koya-open-blind-arena.mjs --public <judge-packet.json>
# パケット外（音声テイク等）を匿名化して比較
node scripts/koya-blind-review.mjs open --set <spec.json>
node scripts/koya-blind-review.mjs record --set <spec.json> --winner A --reviewer <名前> --note "<理由>"
```

採用の記録は公式CLI（`character-approve`、`character-style-select`）に残す。
アリーナの選択は記録ではない。

### 声の人選（2026-09-18 追加。台帳 readiness-9）

Koya の本番経路は**声を自動で選ばない**。鍵があるだけで機械が選んだ声が
有料音声生成へ進んでいたため、人が選んだと言える台帳記録を一つに定めた。

人間選定として数えるのは、voice profile の `casting` が次を**すべて**満たすものだけ
（`lib/koyaVoiceSelectionGuard.mjs` 冒頭が正本）。

- `selectionVersion >= 2`
- 匿名ラベル `selectedCandidateLabel`（A, B, C… の1文字）
- 採用理由 `selectionReason`（4文字以上）
- 採用者 `approvedBy`（自動を示す値は不可）
- 試聴確認 `previewConfirmed === true`
- `candidateSetId` と `auditionCandidateCount >= 2`
- 有効な `selectedAt`
- 自動由来の印が無いこと（method/source/route/origin が "auto" 系でない）

`castRegistryVoices` が書く記録（`selectionVersion` 1、score と persona だけ）は
**何点でも数えない**。profile の id が `auto-` で始まるかは判定に使わない。

- 不足しても Job は**失敗させず一時停止**する（終了コード3・`awaiting-voice-selection`）。
  失敗にすると終端になり、同じ入力での再実行が死んだ Job への再接続になるため。
- 監査は**その回に出る話者**と、ナレーションに紐づく主人公だけを見る。登録簿の全員ではない。
- 主人公は毎話交代する回限りの人物で、固定キャストに含まれない。
  契約が `narrationVoicePolicy=protagonist-voice` なので、ナレーション全行がその人の声になる。
  **固定キャストの声を全部決めても、その回の主人公の声は決まらない。**

**一時停止の解除（2026-09-24 追加）**: 正規入口は `scripts/koya-manga-video.mjs` の
`voice-audition` → `voice-approve`。提供元に依らず、契約が指す台詞 adapter で試聴を作る。

1. `voice-audition --episode-id <台帳の範囲。固定キャストは global> --character-ids a,b`
   が候補ファイルの雛形を書く（既にあれば上書きしない）。人物ごとに台本の台詞1行
   （`sampleLine`。オトシゴには `[angry]` 等のタグを書かない）と、提供元の声一覧から
   選んだ声IDを2〜5個書く。
2. `voice-audition --candidates-path <file> --confirm-paid-preview` が全候補に同じ1行を
   有料で読ませ、A〜E だけの試聴ページ・非公開の対応表・selections を書く。
   確認フラグが無ければ件数だけ出して止まる（終了コード3）。SHA が合う試聴音は払い直さない。
3. 全候補を聴き、selections に `winnerLabel`・`selectionReason`・`previewConfirmed=true` を書く。
4. `voice-approve --selections-path <file> --approved-by <聴いた人の名前>` が verdicts を先に
   保存してから対応表を開き、上の条件を満たす記録を台帳へ書く。

契約の台詞 adapter と提供元が違う声（オトシゴの契約で ElevenLabs の声など）は、
人が選んだ記録があっても音声ゲートが止める。ElevenLabs の契約のあいだは、ゲートの案内は
従来の `build-manga-video.mjs voice-library-*`（Voice Library の無料試聴）のまま。

### 場所（2026-09-18 追加）

背景は、有料生成のほかに**チャット型の画像ツールで作った板を取り込む経路**がある。

```bash
node scripts/koya-manga-video.mjs location-import --location-id <id> --import-map-path <map.json>
node scripts/koya-manga-video.mjs location-anchor-review-draft --location-id <id>
node scripts/koya-manga-video.mjs location-anchor-audit --location-id <id> --location-anchor-review-path <json>
node scripts/koya-manga-video.mjs location-review-draft --location-id <id>
node scripts/koya-manga-video.mjs location-register --location-id <id> --location-review-path <json>
```

- 取り込みは有料呼び出しをしない。既存の板と古い manifest は
  `superseded-<timestamp>/` へ退避し、**消さない**。取り込み自体はアンカー承認にならない。
- 記録が残っていない板は、**作り話で埋めずに欠落として通す**。
  `provenanceGap { reason, specificationPath, specificationSha256 }` に、その画像が満たそうとした
  仕様書を名指しし、`promptRecorded` / `generatorContextRecorded` / `referenceImagesRecorded` の
  うち残っていないものを `false` で挙げる。3つは独立で、`false` だけが受け付けられる。
- 欠落のある板は、欠落した内容に応じて記録が削られる
  （`referenceImagesRecorded: false` なら参照画像は空になり、その板はアンカーSHAを持たない。
  建物の連続性は `architectureLockPass` で目視判定するしかなくなる）。
- 欠落のある板を含むレビューは、独立レビュアーが `provenanceGapAcknowledged: true` を
  立てないと通らない。
- 地名の別名は場所台帳の `aliases` に書く。台本の見出し表記が揺れると別の場所として扱われる。
- 看板などの架空の文字を許す場所は `textPolicy: fictional-signage-allowed` を宣言する。
  宣言すると読める文字の検査が「文字が無いこと」から「架空の文字だけであること」に変わる。

**止まらないことに注意**: 台本に出てくる場所が登録簿に無くても、制作は止まらない。
参照が空のまま4分割の環境アトラスを**有料で新規に描き起こして**それを基準にする。
止まるのは人物だけで、場所には同等のゲートが無い。承認済みの絵と違う場所が
黙って本編に入りうるので、台本を受け取ったら場所の登録状況を先に確かめること。

### 衣装（2026-09-18 追加）

台本が求める服を、**有料の画像生成より前に**登録済みの衣装と照合する。

```bash
node scripts/koya-manga-video.mjs wardrobe-readiness --episode-id <id> --script-path <script>
```

- 無料。`canvas/assets/<episode-id>/wardrobe-readiness.json` を書く。
  終了コード 0 = 全員ぶん揃っている、2 = 未登録の枠がある。
- `images` と `full` は、**その台本そのもの**に対する合格報告が無ければ開始しない。
- 判定に使う場面タグは、asset 側の `sceneTags` と、show bible の
  `outfitStages[].sceneTags` の両方から取る。どちらかに書けば足りる。
- 既定のタグ（daily / work / home）はベース衣装で通る。止まるのは
  formal / swim / sleep / winter-out / summer-out を持つ場面が台本に出たときだけ。
- 新しい衣装が要ると分かってから清書する。台本が来る前に先回りして作らない。

## 制作手順

1. 台本を省略・要約せず解析し、時系列、人物、読み、感情曲線、発話、画面上の証拠を固定する。`koya-story-review-v1`へ攻撃1/2/3、show bible `storyGrammar.castSemantics.reversalSignal`のキャスト（castIdで参照）による号砲、証拠、主人公本人のとどめ、`exitBlocker`のキャストが登場する回だけ退路封鎖1行を実発話IDで記録し、実在地名/ブランド、暴力美化、悪役コメディ、酒語彙抑制を確認する。`story-audit`合格後の同じreviewを`plan/full --story-review-path`へ渡す。台本変更後の古いreviewは使わない。
   開眼（show bibleで`eye-open`必須の人物）は、`story-review-draft`がカット見出しとナレーションから機械提案する`eyeOpenBeats`（発話ID・castId・variant）を、各行の意味で確認して確定する。台詞本文は手がかりにしない。開眼はレアな切り札であり、毎話必須にしない（`castSemantics.recurringEyeOpen`と`requiredEveryEpisode`は、毎話映ることと開眼シートを持つことの要求で、毎話開眼する要求ではない）。開眼場面が0件の回は正常で、同じ人物が1話で2場面を超えて開眼すると`story-review-draft`・`story-audit`・planが警告する（停止はしない）。開眼variantを2つ以上持つ人物はvariant必須。reviewに`eyeOpenBeats`があればそれが正で、無い旧reviewは台本の手がかりと show bible の`eyeOpenVariants[].cues`で判定する。本編の画像ジョブは開眼beatの画像にだけ該当variantの開眼シートを顔の直後に渡し、それ以外の画像には開眼シートを渡さず通常の目を指示する。開眼する人物が特定できない、variantが一意に決まらない、承認済みシートが無い、参照枠に収まらない、のどれかなら有料生成前に停止する。
2. 有料生成前に主人公を一意に決め、`--protagonist-speaker-id`を渡す。複数候補なら推測せず停止する。
3. 判断を`機械で一意に検証可能 / 単一案へ赤入れ / 複数軸から選択`へ分類する。機械判定可能なことを人へ聞かない。単一案の曖昧点は3±1問、複数案は2〜5個の異なる軸を匿名比較し、高コスト・ブランド・好みの判断は人間が理由付きで決める。公開packetにはA〜E、匿名化した実artifact、SHA-256だけを置き、provider・内部ID・生成順・variationAxisの対応表は別のprivate mappingへ隔離する。
4. 年齢段階、顔、髪、体格、服、色、装飾、感情域、禁止差分を持つキャラクターバイブルを作る。新キャラクターは候補承認まで停止し、`character-approve`へ`--candidate-label`と具体的な`--approval-reason`を渡す。内部candidate IDやindexでの承認は禁止する。
   公開済み旧候補シートを正式匿名工程へ移すときは、A〜Eの公開ラベルを保存したまま`character-candidate-migrate-blind --generator-host legacy-migration`を使い、activeラベル、retiredラベル、具体的理由、移行contextを明示する。旧private mappingと公開シートが食い違う場合は衝突記録を残し、ラベルを振り直したり契約上限外の案を黙って昇格したりしない。
   固定キャラは`koya-show-bible.json`の`designStatus`を先に確認し、`pending`/`on-hold`を自動確定しない。人間が選んだ人物でも、実ターンアラウンド・表情セル・必要な衣装/開眼セルのv2レビューが終わるまで台帳へ登録しない。
   `character-approve`のidentity pack生成は人物単位checkpointへ候補SHA、生成context、prompt/model/size、参照SHA、各出力SHAを保存する。停止後は同じ入力と同じcontextで再実行し、digestが一致する生成済み画像だけを再利用する。出所不明の既存画像、入力変更、SHA変異を再開扱いにしない。生成完了後も別contextの原寸セル別reviewが通るまで登録しない。
   固定キャラ準備中は`character-bootstrap-status`でshow bible、既存workflow、選択ラベル、候補review、styling順序、identity pack、台帳を横断し、各人物の次の合法な工程を確認する。新作episodeの前には`cast-readiness`も通す。show bible固定人物が台帳未登録、identity-face/turnaround/expression/指定されたeye-open/outfitのどれか欠落、show bibleの`eyeOpenVariants`で宣言した開眼variantのどれかが台帳に`storyStage`付きで1件ずつ無い（キー無しの旧eye-openシートはvariantの代わりにならない）、identity review SHA欠落、またはon-holdなら、その回だけの代替候補を作らず停止する。show bibleで`requiredEveryEpisode: true`の人物は無言出演でもcharacter bibleへ毎話宣言し、`episodeRoleRequired`が付く人物の登場回は`episodeRole=ally|antagonist`を明記する。
   採用候補の髪型・髪色・衣装・体格・細部を選び直す場合は、三面図へ直行せず`character-style-generate`→別contextによる各案の原寸QA→`character-style-compose`→人間選択→`character-style-select`を挟む。画像モデルへ横並び比較表を直接生成させない。各optionは採用顔1枚だけを身元参照にした独立の完全シートとして生成し、合格optionだけを決定論的に比較シートへ合成する。styling review v2では、合格optionの全ペアについて指定軸の可視差、重複takeでないこと、同一人物性、変更対象外の一致、原寸確認を必須にし、同じ設計のtake違いを候補数へ数えない。既存作品人物への非類似が要件なら、比較参照を`canvas/`へ保存し`--styling-comparison-reference-paths`でSHA拘束する。比較参照は生成モデルへ渡さず、各候補の独立QAだけで輪郭・髪・目元・全体印象を原寸比較する。比較シート自体は台帳へ登録せず、選ばれた個別assetだけを三面図・表情シートの唯一の人物参照にする。`--styling-round-id`を安定IDとして指定し、セッション制限や停止後はround/spec/generator contextを変えず同じコマンドを再実行する。各optionは生成入力SHA・出力path・画像SHAを即時checkpointし、完了済みbytesを再生成しない。公式工程外ですでに生成済みのsheetは捨てたり自動承認したりせず、source manifestと人間作成option mapが出力・入力元・prompt・model・時刻をSHA拘束でき、現specの最低比較数を満たす場合だけ`character-style-import --generator-host legacy-migration`で未承認roundへ取り込む。取り込み後も別contextの原寸QAは省略しない。複数属性を決める場合は1roundへ混ぜず、show bibleのspec path順に前roundの人間選択assetを次roundの唯一の基準にする（`stylingSpecPaths`が複数ある人物は、その配列順が正本）。各roundはspec path/SHA/characterIdを保存し、全宣言roundが選択済みになるまで三面図へ進まない。`kind: "outfit"`のstyling specを持つ人物は、選択後もそのspecが列挙する全衣装のシートを作る。
   location bibleが列挙する背景は`location-plan`→`location-generate --location-stage anchor`→`location-anchor-review-draft`→別contextの原寸review→`location-anchor-audit`→そのreview pathを渡した`location-generate --location-stage continuity`で4個別jobを作る。`--location-stage all`は禁止する。continuityはgeneration manifestへSHA拘束された承認済みanchor候補1枚だけを参照し、各boardの生成context、prompt SHA、anchor SHA、画像SHAを保存する。再利用だけの呼出しでmanifestを書き換えず、新規生成は各boardごとにcheckpointする。全生成contextと異なるreviewerによる原寸・人物0・文字/実在ロゴ0・建築連続性review後にだけ`location-register`する。サムネは`thumbnail-audit`のpreflightが通ってから専用画像を生成し、本編frameとのSHA比較を含むfinal auditを通す。pendingの帯色・書体を推測しない。
5. 発話ごとの意味から構図を設計する。カット見出しだけを全発話へ誤適用しない。人物、背景、証拠、吹き出し余白を同時に設計する。
6. 独立画像jobを適応並列で生成し、技術・意味QAを行う。合格済みhashを再利用し、不合格だけを修正する。利用上限ではcheckpointを書いて停止する。
7. 承認済み日本語ネイティブ音声を人物ごとに固定する。声も最低2候補をA〜Eだけで全件実聴し、provider・voice ID・声名・sourceを伏せたまま`winnerLabel`と理由を先に保存してからprivate mappingを開く。新規作品の四角いナレーション枠は視覚様式を保ち、音声は主人公の承認済みVoice ID/Profile/設定/モデルと完全一致させる。専用ナレーターを作らない。
8. 契約が指す台詞音声アダプタ（`KOYA_DIALOGUE_ADAPTERS` の1件。`config/koya-manga-production-contract.json` の `audio.provider`/`audio.model`）のカット単位text-to-dialogue-with-timestampsで最低2テイクを作り、完全性と自然さで選ぶ。アダプタを本番コードに書き込まない。doctor が非課金で測ったアダプタと契約のアダプタが違えば有料の音声に入らない。BGM は契約の `audio.allowBgm` が true のときだけ、環境音・信号処理は `audio.allowSignalEffects` が true のときだけ使う（2026-09-24 時点はどちらも false）。

手動顔注釈は人物単位で使い回さず、元画像SHA-256ごとに原寸再計測する。別カットで同人物を注釈済みでも、新しい元画像を保護済みと推測しない。窓反射、鏡像、写真・端末画面内の可視顔も、手前の本人顔とは別ID・別矩形のhard faceとして同一画像内に全件在庫化する。
検出コマンドが失敗したのに安定出力パスへ前回の合格レポートが残っている状態を成功としない。source-face配置は今回呼び出しが新しく生成した証拠だけを受理し、失敗時は例外停止する。
9. 実素材上で顔・手・小道具・重要証拠を測り、吹き出しを配置する。検出した人物顔は発話者か否かを問わず全件を`face + hardProtection=true`の0px回避領域にする。自動顔検出が停止した場合、独立した実MP4監査が元画像側の検出漏れ・人物取り違えを示した場合、またはスマホ画面・地図・賞状など台詞理解に不可欠な証拠物が隠れた場合は対象画像を原寸目視し、`koya-source-region-review-v2`へ発話ID、`kind`（`face/hand/prop/evidence/text`）、顔だけは話者ID、正規化領域、画像SHA-256、具体的根拠を記録して`--source-face-review-path`で再開する。同じ画像の全人物頭部を在庫化し、発話者と同じ`speakerId`の手動顔は自動検出が存在してもprimaryを上書きする。特に`thought`は明部の中心そのものがprimaryへ依存するため、群衆・同窓会・複数人物画面では自動最大顔を信用せず、主人公頭部を原寸確認してhash拘束する。自動検出顔は非話者のhard obstacleとして残す。顔と`hardProtection=true`付き重要領域はいずれもカメラ全区間で0px保護する。旧`koya-source-face-review-v1`は顔だけの互換入力として受理するが、新規レビューはv2を使う。検出失敗を無条件承認しない。分割ページは個別素材ではなく黒ガター合成後の実ファイルを原寸で確認し、同じ発話IDでも固有`id`を持つ注釈を全顔ぶん記録する。正規化領域の展開には固定1920x1080ではなく、そのoverlay specの実`imageSize`を使う。顔在庫が0件の分割ページは停止する。画像変更後は同じ変更内で注釈を再計測する。契約移行や表示句読点規則の変更後は、旧SVGを流用せず`node scripts/koya-manga-video.mjs refresh-bubbles --episode-id <episode-id>`で全吹き出しを再生成してから再レンダーする。
10. 連続ナレーションを同一画像へ統合する前に、各文の意味を担う専用画像があるか比較する。「結婚した」の次に「子供が二人」のように可視事実が変わる場合は、同じナレーターでも画像を共有せず、該当文の実画像へ切り替える。長いholdは意味一致を犠牲にして作らない。
10. `manga-page-camera`の3系統を意味に合わせて混在させ、レンダーする。3倍oversampleの長尺レンダーは公式CLIのメモリ連動並列数を使い、16GiB級端末で4並列を強制しない。明示overrideがない限り、1ジョブ約6GiBとして物理メモリとCPUの小さい方へ制限し、swap増加時は同時実行数を下げる。部分修復は`render --cut-ids cut-XX`を使うが、これは再構築する最小集合の指定であって、入力が変わった選択外cutを古いMP4のまま残す許可ではない。選択外cutも、前回の`complete` checkpoint、現在と一致するimage/audio/overlay/camera入力hash、ffprobe実decodeの3条件を満たす場合だけ再利用する。prepareや`refresh-bubbles`が選択外のSVG・配置・cameraを更新した場合は、そのcutも安全に再構築集合へ追加する。旧MP4を現在入力へ再bindingしてはならない。
11. 実MP4から全必須監査と知覚レビューを行う。不合格なら該当範囲だけ修復し、最終監査をやり直す。

## 選択カットの動画差し替え（任意・1話2カットまで）

冒頭やクライマックスなど、印を付けたカットだけを短い image-to-video クリップへ置き換えられる。既定はオフ。置き換わるのはそのカットの映像だけで、音声・吹き出し・尺・前後のタイムラインは変えない。口パクとレイヤー分解のアニメーションはしない。実装は`lib/mangaCutVideoSubstitution.mjs`、実測は`scripts/audit-manga-video-substitution.py`。

- **印の付け方**: エピソード例外`config/koya-manga-episode-overrides/<episode-id>.json`の`override.videoSubstitution`へ、`model`（契約の`allowedModels`から1つ）と`cuts[{cutId, motionPrompt, reason}]`を書く。件数の上限は契約の`maximumCutsPerEpisode`で、スキーマが2を天井にしている。印を変えると契約digestが変わり、以前の監査・署名は無効になる。
- **motionPrompt は「何がどう動くか」だけ**を書く。同一性の維持・文字禁止・口パク禁止・カメラ固定は工程が固定文で付ける。口パクや文字を求める指示は、生成側の禁止文と矛盾してどちらが効くかがモデル次第になるので、契約検証で落ちる。
- **対象外**: 分割ページ（黒ガターとページ全体の単一カメラを保てない）、心の声（明部は元画像へ焼き込む規則）、複数の元画像を持つカット、モデルの最長尺より長いカット。尺の不足を引き伸ばし・ループ・静止の水増しで埋めない。
- **実行位置**: 音声の後・レンダーの前（カット尺が確定してから）。`full`も同じ位置で呼ぶ。開始フレームは承認済み静止画をカメラ設計の t=0 で切った1枚（吹き出し無し）で、見る人が静止画版で最初に見る画と揃う。

```bash
# 開始フレームと費用計画だけを作る（有料APIは呼ばない。終了コード3）
node scripts/koya-manga-video.mjs video-substitute --episode-id <episode-id>
# 費用を確認した後だけ生成する（full では --confirm-paid-video-generation）
node scripts/koya-manga-video.mjs video-substitute --episode-id <episode-id> --confirm-paid-generation
```

- **課金の扱い**: 生成層（`generateVideoMedia`）の例外は課金済みかを区別できないので、この工程は自動で再送しない。呼ぶ前に`video-substitution/ledger.json`へ送信済みを書くので、途中で落ちても「課金状態不明」の試行として残る。失敗・送信のまま止まった試行・検査不合格・完了済みクリップの消失は checkpoint で止まり、再送は`--retry-failed`（`full`では`--retry-failed-video`）を明示したときだけ。試行はカットごとに`maximumGenerationAttemptsPerCut`まで、成功・失敗を問わず数える。完了済みクリップは再開時に再利用し、二度払わない。
- **生成直後の検査**: 全デコード、縦横比、尺、開始フレームとのSSIM（`minimumStartFrameSimilarity`）、要求モデルとの一致。落ちたクリップは課金済みなので保存したまま採用しない。
- **静止画へ戻すのは運営者の判断だけ**: `--allow-still-fallback --still-fallback-cut-ids cut-XX --still-fallback-reason <理由> --still-fallback-decided-by <名前>`。判断は台帳に残り、最終監査で報告される。失敗したカットを黙って静止画で出さない。
- **レンダー前の拘束**: 印の付いたカットは、台帳の完了試行とクリップSHA・開始フレーム仕様・指示内容・モデルが一致する結び付けか、台帳に記録された静止画判断が無ければ止まる。manifestを手で書き換えて出所の無いクリップを結び付ける道もここで塞いでいる。画像・カメラ開始点・指示・モデルを変えたらクリップは作り直しになる。
- **最終監査`video-substitution`**: 実MP4の差し替え区間をデコードし、そのクリップが実際にその区間にあること（吹き出し外で一致）、動きがあり静止の水増しが無いこと、開始フレームとの一致、色の大崩れが無いこと、吹き出し表示中は密サンプルで検出顔と開始時の保護領域（光学フローで追跡）がどちらも0pxであること、文字混入が無いこと（tesseract必須。測れなければ不合格）、フレーム数が一致することを確かめる。`rendered-camera`は差し替えカットを除いた静止カットだけで3系統を測るので、3系統は静止カット側で揃える。
- **人物の同一性は機械で判定しない**。画素指標は本人性を見分けない。署名するレビュー記録の`representativeFramesReviewed.frames`へ、差し替えカットごとに前・中・後の3区間の実フレームを入れ、`characterContinuity`・`bubblePlacement`・`generatedTextArtifacts`を見たと記録する。無ければ`signoff`と`agent-contact-sheet-review`が落ちる。

## 絶対条件

- 表示文は縦書き明朝、通常ウェイト、最大3列、自然な文節改行、末尾`。`なし。長文は意味の切れ目で分割し、同時表示せず1個ずつ切り替える。文字数だけで切らず、固有名詞・複合語・活用語の途中、助詞・助動詞の直前では分割しない。空白だけのtimed segmentを作らない。音声・台本の原文は改変せず、表示用文字列では**全文末尾の句点だけ**を除く。読点、疑問符、感嘆符、文中の`。`は各timed segmentにも保持し、セグメント単位の末尾処理で消さない。通常の1列配置を先に試し、顔0px回避または組版hard gateに失敗した場合だけ、同時表示の自然な2〜3列へ退避する。複数列化を全セグメントへ先回り適用しない。`bubble-typography.json.terminalPunctuation.pass=true`、`naturalSegmentation.pass=true`、全行`terminalPeriodFound=false`を必ず確認する。
- 表示中は発話者だけでなく画面内の全人物の顔・頭と吹き出しの重なりを、カメラ移動中を含め0pxにする。配置座標と最終監査の顔検出を共有しない。最終監査の吹き出し領域は配置計画の矩形ではなく、実際に合成したrasterized overlay PNGのalpha非透明bboxから測る。alpha bboxの正規化には元SVGやoverlay specの寸法ではなく、そのPNGを原寸でdecodeした実pixel幅・高さを使う。実ラスターがあるのに計画座標へ戻して判定しない。独立cascadeの候補は検出confidenceを保存し、校正済み閾値未満の低信頼候補だけを除外する。合格閾値を超えて吹き出しに覆われたcascade候補は、直前直後のbubble-clear frameへ分割ページ全体のカメラ変換を反映して同一物を再探索する。そこにも顔がなければ腕時計・文字・輪郭等のoverlay起因候補として除外し、再投影後にも存在する実顔はconfidenceの高低にかかわらず消さない。
- 思考場面の暗部と顔中心の明部は、カメラ前の元ページへ焼き込む。実MP4監査で顔を画面へ投影するときは、manifestの生focus座標を直接使わず、レンダーと同じcamera mode正規化・終端zoom基準のsafe focus clamp・keyframe再構築を適用する。生座標と実cropが違う状態で明部不合格を出さない。
- 人体、手、指、小道具、遠近、服装段階、人物同一性、背景密度、疑似文字を目視する。機械合格で代用しない。
- 一つの画像に複数発話を自然に保持できる場合、発話ごとに画像を乱造しない。場面転換と因果が読める編集連続性を優先する。
- 承認済み発話WAVを、画像・吹き出し・カメラ修正のついでに再生成しない。
- cut単位ダイアログの分割点は、プロバイダ申告の`start_time_seconds`中点ではなく、文字単位アライメントで囲んだ区間の実測持続無音に置く。申告終端は語尾リリースを含まず実際より約200ms早いので、そこで切ると前話者の残響が次発話の先頭に残る。話者交代の境界で別人の声が混入していないことを`audio-speaker-continuity`で検証する。承認済みテイクからの再分割は再生成ではないので、この修復に有料呼び出しは不要。
- 音声の話者同一性判定に基本周波数を使わない。語頭の弱い基音で男性声が2〜3倍に測定され、オクターブ補正を入れると女性声が副次調波へ落ちて全話者が潰れる。log-melスペクトル包絡＋ケプストラム平均正規化の距離で判定し、同一声（ナレーション=主人公）は参照間距離が小さいことをもって判別不能として明示的にskipする。
- 縦組みのラテン文字・数字は正立させる。`vrt2`（縦組み代替＋回転）はかな・漢字・約物にだけ適用し、ラテン文字へ適用しない。`T大`は倒したTではなく正立Tを縦に積む。
- 吹き出しの表示テキストに読み仮名の括弧注記を残さない（`荒野（あらの）`は`荒野`と表示）。読みは音声テキスト側にだけ持たせる。通常の括弧台詞は消さない。
- 吹き出し分割セグメントの表示タイミングは文字数比例で推定せず、sidecarの`characterTimeline`（プロバイダの文字単位タイムスタンプ）に従う。話速一定の仮定は、間や強調のある長い台詞で後続セグメントを全部ずらす。
- STT結果は、認識時に保存したdecoded PCM SHA-256と順序付き発話本文digestが現在値へ完全一致するときだけ再利用する。同じMP4パスを再抽出して旧STT結果を正当化しない。
- ユーザーの実聴・目視指摘は機械監査より上位。同型不具合を既知のまま再提出しない。
- generator自身、同じ会話contextの別名reviewer、rubricの一部だけの採点、hashのない証拠で品質合格を出さない。generatorとreviewerは実Codex task IDまたはClaude session IDを記録し、別contextでなければ停止する。品質閾値、最大2round、最大時間、最大費用、停滞上限を別々に判定する。
- 品質の合格は、機械ゲート全部pass・rubricの加重平均が目標以上・どの項目も下限以上の3つが揃ったときだけ。下限は同一性・台本との意味の一致・声が80、ほかが60。平均が目標に届いても1項目の下限割れは不合格にする（同一性47点・他は満点の平均92.05が合格していた）。
- 2回目以降のroundは、前回の失敗指紋に対して何を直したかが要る。`audit --revision-delta "直した内容"`か`audits/koya-final/revision-delta.json`（`previousFailureFingerprint`と`revisionDelta`）で渡す。無ければauditは例外ではなく人待ちで止まる。直した版は新しいcontextのreviewerでsignoffし直し、同じcontextのsignoffで再auditしても回は進めない。

## 最終監査

```bash
node scripts/koya-manga-video.mjs audit --episode-id <episode-id>
```

監査で作った実MP4由来contact sheet、代表フレーム、音声区間、全編MP4を実際に確認し、`references/final-review-ja.md`の形式でレビュー記録JSONを作る。契約digest、実MP4/contact sheet/代表フレームのSHA-256、全編確認範囲、冒頭・中盤・終端の音声確認範囲を実値で記録した後だけ署名する。

署名には reviewer 本人の Ed25519 秘密鍵が必須である。鍵・信頼リスト・失効・fail-closed の
規則は`../platform-craft/SKILL.md`の「独立レビューの署名（reviewer attestation）」が正本で、
ここには繰り返さない。鍵が無ければ先に`reviewer-key-create`で作り、公開鍵の`trustEntry`を
owner へ渡して信頼リストへ登録してもらう（同じ端末の同じ主体が信頼リストも書ける構成にしない）。

```bash
node scripts/koya-manga-video.mjs signoff --episode-id <episode-id> \
  --reviewer claude --reviewer-context-id <実Claude-session-id> \
  --review-notes-path /absolute/review.json \
  --reviewer-key-path /secure/outside-repo/reviewer-ed25519.pem \
  --pass
# または --reviewer codex --reviewer-context-id <実Codex-task-id>
# 信頼リストは監査側の BUZZASSIST_REVIEWER_TRUST（path）で解決する。明示するなら --reviewer-trust-path JSON
node scripts/koya-manga-video.mjs audit --episode-id <episode-id>
```

MCP を使える host では、同じ工程を `run_koya_manga_pipeline`（`action: "signoff"` /
`action: "reviewer-key-create"`、`confirmed: true`必須。引数は `reviewerKeyPath`, `reviewerContextId`,
任意 `reviewerTrustPath` の camelCase）で呼ぶ。鍵・信頼リストは path だけを受け、中身は拒否される。
鍵の作成は両ハーネス共通の `create_video_harness_reviewer_key` でもよいが、narrated 専用の
`signoff_video_harness_job` へ Koya Job を渡すと拒否される。上位
`run-video-harness.mjs start|resume --reviewer-trust-path JSON`（MCP `reviewerTrustPath`）は照合用で、
一致した path は上位 Job から `koya-manga-video.mjs full` へも同じ値で渡される。信頼アンカー・失敗コード・
復旧の正本は `../platform-craft/SKILL.md`。

`--reviewer-key-path`が無い signoff は新仕様では必ず失敗する。`audit`は signoff 内の
`reviewerAttestation`を信頼リストで再検証し、鍵が未登録・失効済み・別 subject・信頼リスト
未設定のどれでも不合格にする。同じ検証は RunReceipt 側でも走る。

完了は、契約の完了status、全必須監査PASS、`knownRemainingIssues=[]`、実MP4の全デコード、MP4 hashに結び付き信頼済み reviewer 鍵で署名されたClaude/Codex署名がすべて揃ったときだけ宣言する。報告には絶対MP4パス、尺、解像度、fps、容量、主要監査、残課題0件を含める。
`quality-harness-final`は空の品質ループ状態や事前ゲートだけでは合格しない。独立contextの全rubric採点を含む完了roundが最低1回必要である。自分自身を除く全必須監査の結果・実在証拠SHA-256・契約digest・実MP4 SHA-256・証拠Merkle rootを集約した`final-decision.json`が`passed`であることを確認する。失敗監査は永続incident ledgerへ記録し、再発時の指示/hard-gate昇格を次の新規台本へ引き継ぐ。
