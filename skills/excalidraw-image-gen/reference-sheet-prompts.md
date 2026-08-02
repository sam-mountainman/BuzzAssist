# 設定シート生成プロンプト集（キャラ台帳用）

canvas/characters.json（キャラ台帳）に登録する設定画（リファレンスシート）を生成するためのマスタープロンプト。
新しいキャラクター・小道具（武器等）・舞台を台帳に登録するときは、対応するテンプレートで
シートを生成し、`canvas/assets/characters/`（props / locations はサブフォルダ推奨）へ保存してから
そのパスを台帳の `referenceImagePaths` に登録する。

- 生成には清書品質のモデル（GPT Image 2 / Nano Banana 2 等）を推奨。ラフ探索モデルではシートの
  レイアウト指示が守られにくい。
- `[Character appearance description]` / `[Object / weapon / tool appearance description]` を
  対象の記述に差し替えて使う。環境テンプレートは参照画像（`@.REF.`）を1枚添付して使う。
- 生成したシートは台帳の `kind`（character / prop / location）に対応して登録する。

## キャラクター候補カード（承認前）

候補比較専用。まだ台帳へ登録しない。画風を固定する前に素材接写やゲーム設定画の情報量を
要求すると写実方向へ寄りやすいため、候補段階は全身1点と顔3方向だけに絞る。

~~~
Create one simple 2D manga CHARACTER CANDIDATE CARD for an original character. Landscape 16:9, pure white background, generous spacing. Show exactly one front-facing full-body standing view plus exactly three head studies: front, gentle 3/4, and profile. Every view must be recognizably the same original person. Use the exact linework, face grammar, flat shading, hair treatment, palette, and visual information density required by the channel style lock. No material swatches, no garment/fabric/skin/hand/shoe close-ups, no realistic texture, no extra panels, no props, no captions, no readable text, no logo, no watermark, and no UI. Character setup: [Character appearance description]
~~~

## キャラクターシート（kind: "character"）

~~~
A high-definition, clean, minimalist character design board / character turnaround reference sheet, set against a pure white background. The overall presentation should resemble a professional game art character modeling sheet, fashion design reference page, character design sheet, or character turnaround board. The layout should be neat and well-organized, with clearly divided information sections, a realistic and premium visual quality, consistent lighting, and strict character consistency throughout. On the left side of the composition, show the character’s full-body three-view turnaround, occupying the main visual area, including: 1. Front full-body standing pose 2. Left-side full-body standing pose 3. Back full-body standing pose All three figures must be the exact same character, with identical facial features, hairstyle, clothing, body shape, and height proportions. The standing pose should feel natural, with both arms hanging naturally at the sides. This should be suitable as a character modeling reference. The camera angle should be eye level, with neutral studio lighting, no obstruction, no exaggerated perspective, and no complex background. The right side of the composition should be divided into two sections: In the upper-right section, place six headshot / head-angle reference images of the same character, arranged neatly to show different head perspectives, including: - Front-facing portrait - Slight downward angle showing the top of the head - Back of the head / rear head view - Left-side facial profile - A near-side-angle comparison view (this line was slightly unclear in the source and may not be exact) - 3/4 profile portrait The head references should have clear facial features, visible hair parting, and consistent facial structure, making them suitable as head design references. In the lower-right section, place six close-up detail images of the character, arranged into a clean grid, showing key design details, including: - Close-up of the upper garment fabric texture - Front close-up of the lower-body clothing - Close-up of the hip / tailoring detail - Close-up of the leg or skin texture detail - Close-up of the eyes or facial feature details - Full close-up of the shoes as a standalone item All detail images must match the main character’s outfit and appearance exactly. Materials should look realistic, and the details should be clean and precise, suitable as clothing and accessory modeling references. Overall style requirements: Minimalist, professional, realistic, unified, clean, and premium, similar to a character design board, fashion design reference sheet, 3D character modeling reference page, or character turnaround presentation board. The character edges should be sharp, garment shapes should be clearly defined, hair strands should appear natural, skin should look refined, and material rendering should be accurate. The overall layout should have generous white space, as if it were made by a professional concept art team. Character setup: [Character appearance description] Output requirements: Landscape composition, white background, full character visible, no cropping, no extra props, no explanatory text, no logo, no watermark, no UI interface elements, no like/save buttons, and no social-media-screenshot appearance.
~~~

## 武器・小道具シート（kind: "prop"）

~~~
A high-definition, clean, minimalist industrial design board / prop design reference sheet, set against a pure white background. The overall presentation should resemble a professional game art prop sheet, weapon design board, hard-surface modeling reference page, product concept sheet, or industrial design turnaround board. The layout should be neat, balanced, and well-organized, with clearly divided information sections, realistic and premium visual quality, consistent lighting, and strict object consistency throughout.

On the left side of the composition, show the object’s main three-view turnaround, occupying the primary visual area, including:
1. Front view
2. Side view
3. Back view

All three views must depict the exact same object, with identical shape language, proportions, materials, surface treatment, construction details, and scale relationships. This should be suitable as a hard-surface modeling reference. The camera angle should be orthographic or near-orthographic, at eye level, with neutral studio lighting, no obstruction, no exaggerated perspective, and no complex background.

The right side of the composition should be divided into two sections:

In the upper-right section, place six supplementary angle reference images of the same object, arranged neatly to show different perspectives and structural understanding, including:
- 3/4 front perspective view
- 3/4 rear perspective view
- Top view
- Bottom view
- Opposite side profile view
- Slightly elevated angle view showing surface transitions and silhouette

These reference views should clearly show the object’s overall form, edge flow, volume transitions, assembly structure, and distinctive design features, making them suitable as form design references.

In the lower-right section, place six close-up detail images of the object, arranged into a clean grid, showing key material and construction details, including:
- Close-up of the primary surface material or finish
- Close-up of the grip, handle, or holding section
- Close-up of a joint, seam, connector, or assembly line
- Close-up of a mechanical part, edge detail, fastening detail, or structural element
- Close-up of a functional area such as the blade, barrel, trigger area, emitter, tip, or striking end
- Close-up of a secondary material detail such as metal wear, painted surface, rubber, leather wrap, polymer texture, or engraved markings

All detail images must match the main object exactly in form, material, and design language. Materials should look realistic, and the details should be clean, precise, and suitable as hard-surface modeling references.

Overall style requirements:
Minimalist, professional, realistic, unified, clean, and premium, similar to a prop design board, weapon reference sheet, industrial design presentation board, or 3D hard-surface modeling reference page. The object edges should be sharp and clearly defined, surface planes should read cleanly, material transitions should be accurate, small structural details should be precise, and rendering should feel polished and production-ready. The overall layout should have generous white space, as if it were made by a professional concept art team.

Object setup:
[Object / weapon / tool appearance description]

Output requirements:
Landscape composition, white background, full object visible, no cropping, no extra props, no explanatory text, no logo, no watermark, no UI interface elements, no like/save buttons, and no social-media-screenshot appearance.
~~~

## 環境リファレンスボード（kind: "location"）

参照画像（`@.REF.`）として既存のワールド/セットの画像を1枚添付して使う。

~~~
WORLD/PLACE: @.REF. から環境/セットを特定し、派生させます。そのNAMEとATMOSPHEREラベルを与えてください。実際の建築、レイアウト、パレット、素材を決して変更しないでください。

STYLE: @.REF. から推測します。完全に一致するスタイルと仕上げに合わせます。

BOARD CANVAS: すべてのスタディを、ゆとりのあるネガティブスペース付きの柔らかいニュートラルキャンバス上に配置します。各スタディはソース通りのワールド内バックドロップ/ペイントされた空を保持します — 平らな白背景にシーンを孤立させないでください。

DESIGN DIRECTION: 標準的なセットブループリントやフロアプランシートを作成しないでください。
シネマティックなLOCATIONアイデンティティボードを作成します。高級アニメーションスタジオのセットバイブルとアートブックレイアウトをミックスしたようなもの。
非対称的で、エレガントで、視覚的に記憶に残るもの。大きな空きスペース、多様な画像スケール、意図的な不均衡を使用します。
グリッド、タイル状のカタログレイアウト、繰り返しの同サイズビネットを避けます。

IMPORTANT LAYOUT RULE: どのビューも重ねないでください。
すべてのスタディ（ワイドショット、アングルスタディ、テクスチャスウォッチ、プロップスタディ、マップ）は、明確な分離と呼吸するスペースを持たなければなりません。
マージされたシーン、クロップされた建物、重ねられたビネットはなし。

MAIN COMPOSITION (angle studies of the SAME location): 視覚的なアンカーとして、1つの大きなヒーローESTABLISHING WIDEを少しオフセンターに配置します。
その周りに、小さなサポートアングルスタディをクリーンなスペースで配置します：目線の高さから通りを見下ろすショット、リバースアングル（振り返る）、ハイアングル/ほぼトップダウンのレイアウト、ストリートレベルからのローアングル、コーナー/建築的ディテールのビスタ、そして未来のキャラクターを挿入する準備ができたクリーンな空の「ステージ」フレーム。
各ビューは、異なるカメラからの同一の場所として読めるようにしなければなりません。異なる町のものではありません。

SPATIAL & MATERIAL LOCK (this is the consistency core): すべてのビューで厳格な一貫性を保ちます：同一の建築と建物形状、同一の正確なカラーパレット、同一の手作り素材とテクスチャ、同一のキーランドマークを同一の相対位置に、同一のライティングロジック、建物、ドア、家具、ストリートの同一のスケール関係。

USEFUL REFERENCE DETAILS: 将来の画像とビデオ生成のためにセットを読みやすくします：明確なレイアウト、明確なランドマーク配置、明確なパレット、明確な素材/テクスチャ、明確なライティング方向、明確なスケールキュー（将来のキャラクターがドア、街灯、カフェ家具に対してどれくらいの高さになるか）。

STUDY SECTIONS:
- MATERIAL & TEXTURE study: シグネチャ素材の3-4つのクローズアップスウォッチ（フェルト状の葉、クレイ壁仕上げ、小石、ファブリック/花のテクスチャ）。
- LIGHTING STATES study: 同一のエスタブリッシングビューを異なる光の下で2-3つの小さなバリエーション（例：デイライト、ゴールデンアワー、夕暮れ）。ワールドに合わないものは省略。
- KEY PROPS / LANDMARK study: ショット間で一貫性を保つためのシグネチャオブジェクトの孤立スタディ（例：街灯、アクセントドア、カフェテーブル+カップ、木のタイプ、花のクラスター）。
- LAYOUT MAP: 建物、通り、木、ランドマークの位置を示す小さな簡略化されたトップダウンスケッチ。
- PALETTE: 正確なカラーチップの小さな行。

TEXT DESIGN:
1つのスタイリッシュなLOCATION IDブロックを追加します。ミニマルで、ボールドで、アートディレクションされたもの。只使用：
NAME
TYPE / SETTING
CRAFT & MATERIAL SIGNATURE
PALETTE
KEY LANDMARKS
ATMOSPHERE
役立つ箇所にのみ小さな手書きスタイルのラベルを使用。微妙な編集用矢印/注釈は許可されますが、ミニマルでエレガントに保ちます。

STYLE: ミニマル、シネマティック、プレミアム、アートブック風、タクタイル、プロダクションに有用。
最終画像は、AIモデルがレイアウト、建築、素材、パレット、ライティング、ランドマークを複数のカメラアングルで理解するのを助けるセットバイブルとして感じられるべきです。一貫した画像とビデオ生成のために。
~~~
