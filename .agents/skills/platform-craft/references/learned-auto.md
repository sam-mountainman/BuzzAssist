<!-- このファイルは harness-learn が自動で書きます。手で編集しないでください。 -->

# 自動で積み上がった指摘

隣の `SKILL.md` が正本で、**矛盾したときは SKILL.md が優先**します。
ここは運用上の補助指示であって、**監査・承認・合否の証跡には使えません**。

- **課金APIの再送は 429/5xx/ネットワーク断だけ。2xxを受けた後の失敗は再送しない（サーバは仕事を終えている＝課金済み）。再送可否は本文を読む前にステータスだけで決める——本文の読み取りが失敗すると判定の付かないまま catch へ落ち、印の無い再送が起きる**
  - 根拠: リポジトリ内に再送実装が4つあり規則が全部違っていた（lovart: GET3回/POST1回、mediaGeneration: 一律3回、buzzassistApi: 429のみ段階、koyaDialogueSpeech: 再送なし）。lib/paidApiRetry.mjs へ集約
  - 種別: fact / 初回: 2026-08-28 / id: `6cb267bfbc38`
- **合成 fixture を実データの正本と同じ顔で返さない。fixture へ落ちたことを source に出し、本番の入口は既定で拒否する。20か所ある呼び出し側に個別ガードを足す形だと、後から増えた1か所が素通りする**
  - 根拠: channel-pack 分離時に入れた fixture フォールバックが source:"project" と記録され、サンプルのキャストで作った成果物に「プロジェクトの正本に準拠」と署名される状態だった
  - 種別: constraint / 初回: 2026-08-28 / id: `31bbccb29245`
- **走っていないゲートを「通った」と書けない形にする。宣言されたゲートに判定が1件でも欠けていれば finalize を失敗させ、判定には証拠の指紋を要求し、理由のない skip を拒否し、落ちたゲートがあれば pass の申告を上書きする**
  - 根拠: このコードベースの不具合の大半は「機能が動いていない」ではなく「検証したと書いてあるのに検証していない」だった。lib/harnessRunReceipt.mjs で記録の層にも同じ規律を入れた
  - 種別: constraint / 初回: 2026-08-28 / id: `ee09f8457193`
- **契約は版で増減するので、記録は効力のあった契約で測る。当時存在しなかった監査を「未実施」と数えると過去の成果物が後から一斉に不合格になる。ただし契約から保証の裏づけが全部消えた場合は pass ではなく skip——契約が縮んで保証が黙って無効になるのが穴の入口**
  - 根拠: v50のエピソードを現行v51の契約で測り、その版に存在しない audio-speaker-continuity のぶんだけ過去作3件が落ちた
  - 種別: fact / 初回: 2026-08-28 / id: `a1f682fa6c05`
- **既存のversioned成果物ディレクトリへ書く前に存在と監査SHAを確認し、既存版へ新成果物を混在・上書きしない。衝突時は次の新versionを作り、誤書込みは正本SHAへ復元して記録する。**
  - 根拠: 2026-08-30 Mike image-harness-v10が既存なのを作成後に検知。scene-plan-v10 SHAとimage-harness-v10-style-benchmark/cleaned-finalから7枚を元SHAへ復元し、新修正はv11へ分離。
  - 種別: correction / 初回: 2026-08-29 / id: `6fc1a6d87bdd`
- **最終化は現在のハーネス版の実MP4・plan・自動監査・contact sheet・外部review notesをSHA拘束し、旧版auditを代替証拠として受理しない。自動監査は独立目視signoffを生成せず awaiting-independent-signoff で停止する**
  - 根拠: client-work/mike-san/yamaaritaniari-v1/reports/v18-integration-independent-code-review.md V18-001/V18-006; production/finalize-review-v18.mjs; production/finalize-complete-video.mjs
  - 種別: correction / 初回: 2026-08-29 / id: `85c4ff144509`

_最終更新: 2026-08-31T09:47:39.893Z_
