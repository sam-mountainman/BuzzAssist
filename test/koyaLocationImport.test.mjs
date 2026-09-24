// チャット型の画像ツールで作った背景ボードを、公式の審査ルートへ取り込む。
// 場所・会話・審査者はすべて架空の汎用名。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  auditKoyaLocationAnchorReview,
  auditKoyaLocationReview,
  buildKoyaLocationBoardPlan,
  createKoyaLocationAnchorReviewDraft,
  createKoyaLocationReviewDraft,
  generateKoyaLocationBoards,
  importKoyaLocationBoards,
  koyaLocationAnchorCheckKeys,
  koyaLocationBoardCheckKeys,
  registerApprovedKoyaLocation,
  validateKoyaLocationBible,
} from "../lib/koyaChannelGovernance.mjs";
import { readCharacterRegistry, writeCharacterRegistry } from "../lib/characterRegistry.mjs";
import { createMangaScriptImagePlan } from "../lib/mangaScriptImagePipeline.mjs";
import {
  CHAT_CONTEXT,
  IMPORTER,
  boardPng,
  importAndRegisterSyntheticLocation,
  installSyntheticKoyaAuthority,
  passAnchorChecks,
  passBoardChecks,
  readJson,
  sha256,
  syntheticLocationBible,
  writeSyntheticImport,
} from "./helpers/koyaLocationFixture.mjs";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

async function withProject(prefix, callback) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  try {
    const projectDir = join(root, "project");
    const authority = await installSyntheticKoyaAuthority(projectDir);
    return await callback({ root, projectDir, authority });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function listFiles(dir) {
  try { return (await readdir(dir, { recursive: true })).sort(); } catch { return []; }
}

test("imported boards pass the full official route: anchor review, final review, and registration with aliases", async () => {
  await withProject("koya-location-import-", async ({ root, projectDir, authority }) => {
    const locationId = "sample-street";
    const common = { projectDir, locationBible: authority.locationBible, showBible: authority.showBible, locationId };
    const sourceDir = join(root, "downloads");
    const prepared = await writeSyntheticImport({ authority, locationId, sourceDir });
    const imported = await importKoyaLocationBoards({ authority, locationId, importMapPath: prepared.mapPath });
    assert.equal(imported.complete, true);
    assert.equal(imported.anchorApproved, false);
    assert.deepEqual(imported.superseded.moved, []);
    const plan = buildKoyaLocationBoardPlan(common);
    // 元ファイルは動かさず、計画どおりの場所へ複製する。
    for (const [index, source] of prepared.sources.entries()) {
      assert.equal(sha256(await readFile(source.path)), source.sha256);
      assert.equal(sha256(await readFile(plan.jobs[index].outputPath)), source.sha256);
    }
    const manifest = await readJson(imported.manifestPath);
    assert.equal(manifest.version, "koya-location-generation-v2");
    assert.equal(manifest.anchorApproval, null, "取り込みはアンカー承認を書かない");
    assert.deepEqual(manifest.requiredBoardIds, plan.jobs.map((job) => job.boardId));
    const [anchorEntry, ...continuityEntries] = manifest.entries;
    assert.equal(anchorEntry.anchorSha256, "");
    assert.ok(continuityEntries.every((entry) => entry.anchorSha256 === prepared.sources[0].sha256));
    assert.deepEqual(Object.keys(anchorEntry), ["boardId", "path", "sha256", "dimensions", "promptSha256", "anchorSha256", "generator", "generatedAt", "reused", "import"]);
    assert.deepEqual(anchorEntry.generator, { host: "chat-web-image-tool", id: "synthetic-image-model", contextId: CHAT_CONTEXT });
    assert.equal(anchorEntry.reused, false);
    assert.equal(anchorEntry.import.mapSha256, sha256(await readFile(prepared.mapPath)));
    assert.equal(anchorEntry.import.sourceSha256, anchorEntry.sha256);
    assert.deepEqual(anchorEntry.import.importedBy, IMPORTER);
    assert.equal(anchorEntry.import.planPromptSha256, sha256(plan.jobs[0].prompt));
    assert.equal(anchorEntry.promptSha256, sha256(prepared.map.boards[0].promptText));
    assert.equal(manifest.entries[3].promptSha256, prepared.map.boards[3].promptSha256, "promptPath の SHA がそのまま残る");
    assert.equal(manifest.entries[2].import.note, "operator chose this take from four variations");

    // アンカー審査: 文字方針が架空看板を許す場所では readableTextFictionalOnly を問う。
    const anchorDraft = await createKoyaLocationAnchorReviewDraft(common);
    assert.deepEqual(Object.keys(anchorDraft.anchor.checks), koyaLocationAnchorCheckKeys(authority.locationBible.locations[1]));
    assert.ok(Object.hasOwn(anchorDraft.anchor.checks, "readableTextFictionalOnly"));
    assert.equal(Object.hasOwn(anchorDraft.anchor.checks, "readableTextAbsent"), false);
    assert.match(anchorDraft.instructions, /importer/u);
    const unreviewed = await auditKoyaLocationAnchorReview({ ...common, review: anchorDraft });
    assert.equal(unreviewed.pass, false);
    const anchorReview = passAnchorChecks(structuredClone(anchorDraft));
    anchorReview.reviewer = { host: "codex", id: "anchor-reviewer", contextId: "session-anchor-reviewer" };
    anchorReview.reviewedAt = "2026-09-18T01:00:00.000Z";
    const anchorAudit = await auditKoyaLocationAnchorReview({ ...common, review: anchorReview });
    assert.equal(anchorAudit.pass, true, anchorAudit.failures.join("\n"));
    for (const [contextId, pattern] of [
      [IMPORTER.contextId, /different from the importer/u],
      [CHAT_CONTEXT, /different from its generator/u],
      [`${CHAT_CONTEXT}-view-3`, /different from every external generator/u],
    ]) {
      const sameContext = structuredClone(anchorReview);
      sameContext.reviewer.contextId = contextId;
      const rejected = await auditKoyaLocationAnchorReview({ ...common, review: sameContext });
      assert.equal(rejected.pass, false, contextId);
      assert.match(rejected.failures.join("\n"), pattern);
    }
    const plainTextCheck = structuredClone(anchorReview);
    delete plainTextCheck.anchor.checks.readableTextFictionalOnly;
    plainTextCheck.anchor.checks.readableTextAbsent = true;
    assert.match((await auditKoyaLocationAnchorReview({ ...common, review: plainTextCheck })).failures.join("\n"), /readableTextFictionalOnly/u);
    const reviewsDir = join(projectDir, "canvas", "reviews");
    await mkdir(reviewsDir, { recursive: true });
    const anchorReviewPath = join(reviewsDir, "street-anchor.json");
    await writeFile(anchorReviewPath, `${JSON.stringify(anchorReview, null, 2)}\n`);

    // 公式の有料生成は、取り込んだ継続ビューを黙って再利用も上書きもしない（force が要る）。
    let paidCalls = 0;
    await assert.rejects(() => generateKoyaLocationBoards({
      authority,
      locationId,
      stage: "continuity",
      anchorReviewPath,
      generator: { host: "codex", id: "generator", contextId: "session-generator" },
      generateImage: async () => { paidCalls += 1; return { buffer: boardPng("never") }; },
    }), /different anchor approval; pass force=true/u);
    assert.equal(paidCalls, 0);
    assert.equal(sha256(await readFile(imported.manifestPath)), imported.manifestSha256);

    // 本審査: 取り込みでは manifest にアンカー承認が無いので、review 側で拘束する。
    const unboundDraft = await createKoyaLocationReviewDraft(common);
    assert.deepEqual(unboundDraft.anchorApproval, { path: "", sha256: "" });
    assert.match(unboundDraft.instructions, /--location-anchor-review-path/u);
    const draft = await createKoyaLocationReviewDraft({ ...common, anchorReviewPath });
    assert.deepEqual(draft.anchorApproval, { path: anchorReviewPath, sha256: sha256(await readFile(anchorReviewPath)) });
    assert.equal(draft.generationManifest.sha256, imported.manifestSha256);
    assert.ok(draft.boards.every((board) => JSON.stringify(Object.keys(board.checks)) === JSON.stringify(koyaLocationBoardCheckKeys(authority.locationBible.locations[1]))));
    const review = passBoardChecks(structuredClone(draft));
    review.reviewer = { host: "codex", id: "final-reviewer", contextId: "session-final-reviewer" };
    review.reviewedAt = "2026-09-18T02:00:00.000Z";
    const audit = await auditKoyaLocationReview({ ...common, review });
    assert.equal(audit.pass, true, audit.failures.join("\n"));
    assert.equal(audit.anchorApproval.source, "review");
    assert.equal(audit.textPolicy, "fictional-signage-allowed");

    const rejectedReview = async (mutate, pattern, message) => {
      const candidate = structuredClone(review);
      mutate(candidate);
      const result = await auditKoyaLocationReview({ ...common, review: candidate });
      assert.equal(result.pass, false, message);
      assert.match(result.failures.join("\n"), pattern, message);
    };
    await rejectedReview((candidate) => { delete candidate.anchorApproval; }, /require review\.anchorApproval/u, "アンカー承認なし");
    await rejectedReview((candidate) => { candidate.anchorApproval.sha256 = "0".repeat(64); }, /SHA-256 no longer matches/u, "アンカー承認の SHA 違い");
    await rejectedReview((candidate) => { candidate.anchorApproval.extra = true; }, /exactly path and sha256/u, "未知キー");
    await rejectedReview((candidate) => { candidate.reviewer.contextId = IMPORTER.contextId; }, /different from its importer/u, "取り込んだ人と同じ context");
    await rejectedReview((candidate) => { candidate.reviewer.contextId = `${CHAT_CONTEXT}-view-2`; }, /different from its generator/u, "外部生成と同じ context");
    await rejectedReview((candidate) => {
      delete candidate.boards[1].checks.readableTextFictionalOnly;
      candidate.boards[1].checks.readableTextAbsent = true;
    }, /readableTextFictionalOnly/u, "文字方針の確認項目の取り違え");
    await rejectedReview((candidate) => { candidate.generationManifest.sha256 = "f".repeat(64); }, /manifest SHA-256 does not match/u, "manifest の SHA 拘束");

    // 未審査のアンカー承認は受けない。
    const unpassedAnchor = structuredClone(anchorDraft);
    unpassedAnchor.reviewer = { host: "codex", id: "anchor-reviewer", contextId: "session-anchor-reviewer" };
    unpassedAnchor.reviewedAt = "2026-09-18T01:00:00.000Z";
    const unpassedAnchorPath = join(reviewsDir, "street-anchor-unpassed.json");
    await writeFile(unpassedAnchorPath, `${JSON.stringify(unpassedAnchor, null, 2)}\n`);
    await rejectedReview((candidate) => {
      candidate.anchorApproval = { path: unpassedAnchorPath, sha256: sha256(JSON.stringify(unpassedAnchor, null, 2) + "\n") };
    }, /anchor approval is no longer valid/u, "不合格のアンカー審査");

    const reviewPath = join(reviewsDir, "street-final.json");
    await writeFile(reviewPath, `${JSON.stringify(review, null, 2)}\n`);
    const registered = await registerApprovedKoyaLocation({ authority, projectDir, locationId, reviewPath });
    const entry = registered.location;
    assert.equal(entry.kind, "location");
    assert.equal(entry.status, "approved");
    assert.deepEqual(entry.aliases, ["商店街", "駅前の商店街"]);
    assert.equal(entry.referenceAssets.length, 4);
    assert.deepEqual(entry.referenceAssets.map((asset) => asset.sha256), prepared.sources.map((source) => source.sha256));
    assert.match(entry.negativePrompt, /real names or real brands on signs/u);
    assert.doesNotMatch(entry.negativePrompt, /readable text/u);
    assert.match(entry.approval.reason, /imported from an external image tool/u);

    // 審査後に manifest を書き換えると、登録済みでも本審査は通らない。
    const tampered = await readJson(imported.manifestPath);
    tampered.entries[1].generator.contextId = "session-final-reviewer-2";
    await writeFile(imported.manifestPath, `${JSON.stringify(tampered, null, 2)}\n`);
    assert.match((await auditKoyaLocationReview({ ...common, review })).failures.join("\n"), /manifest SHA-256 does not match/u);

    // 場面見出しの場所名が別名と一致すれば、本編の画像計画はその登録ボードを参照する。
    const registry = await readCharacterRegistry({ projectDir });
    const script = [
      "---",
      "タイトル: 商店街の落とし物",
      "登場人物:",
      "  - 名前: 山田花子",
      "    主人公: はい",
      "---",
      "",
      "#場面 1 商店街・夜",
      "山田花子：この財布、誰のだろう",
      "#場面 2 公園・昼",
      "山田花子：交番に届けよう",
    ].join("\n");
    const canvasDir = join(projectDir, "canvas");
    const imagePlan = createMangaScriptImagePlan({
      scriptText: script,
      registry,
      assetDir: join(canvasDir, "assets", "sample-episode"),
      canvasDir,
    });
    const [streetCut, parkCut] = imagePlan.manifest.cuts;
    assert.equal(streetCut.location.name, "商店街");
    const anchorBoardPath = join(canvasDir, entry.referenceAssets[0].path);
    const streetJobs = imagePlan.jobs.filter((job) => ["scene-image", "split-panel"].includes(job.kind) && job.location?.id === streetCut.locationId);
    assert.ok(streetJobs.length > 0);
    assert.ok(streetJobs.every((job) => job.referenceImagePaths.includes(anchorBoardPath)), JSON.stringify(streetJobs.map((job) => job.referenceImagePaths)));
    assert.equal(imagePlan.jobs.some((job) => job.id === `environment-sheet:${streetCut.locationId}`), false);
    // 登録の無い場所は従来どおり、その回だけの背景参照を作る。
    assert.equal(imagePlan.jobs.some((job) => job.id === `environment-sheet:${parkCut.locationId}`), true);
  });
});

test("承認済みの絵を直して作った継続ビューは derived で取り込め、アンカーへの拘束の代わりに目の確認を要る", async () => {
  // 例: 承認済みのボードの一部（看板）だけを、そのボードを添付して描き直した。
  // アンカーは添付していないので anchor とは書けない。書けば作り話の記録になる。
  await withProject("koya-location-derived-", async ({ root, projectDir, authority }) => {
    const locationId = "sample-street";
    const common = { projectDir, locationBible: authority.locationBible, showBible: authority.showBible, locationId };
    const sourceDir = join(root, "downloads");
    const priorBytes = boardPng("previously-approved-view-2");
    const priorPath = join(sourceDir, "previously-approved-view-2.png");
    const prepared = await writeSyntheticImport({
      authority,
      locationId,
      sourceDir,
      mutate: async ({ map }) => {
        await mkdir(sourceDir, { recursive: true });
        await writeFile(priorPath, priorBytes);
        map.boards[1].referenceImages = [{ path: priorPath, sha256: sha256(priorBytes), role: "derived" }];
      },
    });
    const imported = await importKoyaLocationBoards({ authority, locationId, importMapPath: prepared.mapPath });
    assert.equal(imported.complete, true);
    const manifest = await readJson(imported.manifestPath);
    assert.equal(manifest.entries[1].anchorSha256, "", "アンカーを添付していないボードにアンカーの SHA を書かない");
    assert.equal(manifest.entries[2].anchorSha256, prepared.sources[0].sha256, "ほかの継続ビューは従来どおりアンカーに拘束する");

    const anchorDraft = await createKoyaLocationAnchorReviewDraft(common);
    const anchorReview = passAnchorChecks(structuredClone(anchorDraft));
    anchorReview.reviewer = { host: "codex", id: "anchor-reviewer", contextId: "session-anchor-reviewer" };
    anchorReview.reviewedAt = "2026-09-18T01:00:00.000Z";
    assert.equal((await auditKoyaLocationAnchorReview({ ...common, review: anchorReview })).pass, true);
    const reviewsDir = join(projectDir, "canvas", "reviews");
    await mkdir(reviewsDir, { recursive: true });
    const anchorReviewPath = join(reviewsDir, "street-anchor.json");
    await writeFile(anchorReviewPath, `${JSON.stringify(anchorReview, null, 2)}\n`);

    const draft = await createKoyaLocationReviewDraft({ ...common, anchorReviewPath });
    assert.match(draft.instructions, /edited from previously approved images/u);
    assert.match(draft.instructions, new RegExp(manifest.entries[1].boardId, "u"));
    const review = passBoardChecks(structuredClone(draft));
    review.reviewer = { host: "codex", id: "final-reviewer", contextId: "session-final-reviewer" };
    review.reviewedAt = "2026-09-18T02:00:00.000Z";
    const audit = await auditKoyaLocationReview({ ...common, review });
    assert.equal(audit.pass, true, audit.failures.join("\n"));

    const unchecked = structuredClone(review);
    const continuityKey = Object.keys(unchecked.boards[1].checks).find((key) => /architecture/iu.test(key));
    assert.ok(continuityKey, "建築の一致を見る確認項目がある");
    unchecked.boards[1].checks[continuityKey] = false;
    const refused = await auditKoyaLocationReview({ ...common, review: unchecked });
    assert.equal(refused.pass, false);
    assert.match(refused.failures.join("\n"), /edited from previously approved images, not drawn from the anchor/u);
  });
});

test("継続ビューの参照が other だけなら、derived と書かない限り従来どおりアンカー参照を要る", async () => {
  await withProject("koya-location-derived-other-", async ({ root, authority }) => {
    const sourceDir = join(root, "downloads");
    const prepared = await writeSyntheticImport({
      authority,
      locationId: "sample-street",
      sourceDir,
      mutate: async ({ map, sources }) => {
        map.boards[1].referenceImages = [{ path: sources[2].path, sha256: sources[2].sha256, role: "other" }];
      },
    });
    await assert.rejects(
      importKoyaLocationBoards({ authority, locationId: "sample-street", importMapPath: prepared.mapPath }),
      /role "anchor" reference, or list the approved images it was edited from as role "derived"/u,
    );
  });
});

test("location import rejects invalid maps and writes nothing", async () => {
  const cases = [
    {
      name: "sha mismatch",
      mutate: ({ map }) => { map.boards[1].sourceSha256 = "0".repeat(64); },
      match: /boards\[1\]\.sourceSha256 does not match the source file/u,
    },
    {
      name: "missing board",
      mutate: ({ map }) => { map.boards.splice(2, 1); },
      match: /missing required board 3/u,
    },
    {
      name: "duplicate board",
      mutate: ({ map }) => { map.boards[2] = { ...map.boards[2], boardIndex: 1 }; },
      match: /names required board 1 .* a second time/u,
    },
    {
      name: "unknown top-level key",
      mutate: ({ map }) => { map.approvedBy = "someone"; },
      match: /import map has unknown key\(s\): approvedBy/u,
    },
    {
      name: "unknown board key",
      mutate: ({ map }) => { map.boards[0].anchorApproved = true; },
      match: /boards\[0\] has unknown key\(s\): anchorApproved/u,
    },
    {
      name: "unknown generator key",
      mutate: ({ map }) => { map.boards[0].generator.sessionLog = "x"; },
      match: /boards\[0\]\.generator has unknown key\(s\): sessionLog/u,
    },
    {
      name: "undersized image",
      mutate: async ({ map, sourceDir }) => {
        const small = boardPng("small", 1024, 576);
        await writeFile(join(sourceDir, "download-2.png"), small);
        map.boards[1].sourceSha256 = sha256(small);
      },
      match: /boards\[1\] is 1024x576; location boards must be at least 1280x720/u,
    },
    {
      name: "not a png",
      mutate: async ({ map, sourceDir }) => {
        const bytes = Buffer.from("<svg width='1920' height='1080'></svg>");
        await writeFile(join(sourceDir, "download-2.png"), bytes);
        map.boards[1].sourceSha256 = sha256(bytes);
      },
      match: /must be a PNG image/u,
    },
    {
      name: "duplicate image bytes",
      mutate: ({ map, sources }) => {
        map.boards[2].sourcePath = sources[1].path;
        map.boards[2].sourceSha256 = sources[1].sha256;
      },
      match: /two boards share a SHA-256/u,
    },
    {
      name: "continuity view without the anchor reference",
      mutate: ({ map }) => { map.boards[1].referenceImages = []; },
      match: /boards\[1\] is a continuity view; list the imported anchor board/u,
    },
    {
      name: "anchor with an anchor reference",
      mutate: ({ map, sources }) => { map.boards[0].referenceImages.push({ path: sources[1].path, sha256: sources[1].sha256, role: "anchor" }); },
      match: /boards\[0\] is the anchor board/u,
    },
    {
      name: "index and label disagree",
      mutate: ({ map, plan }) => { map.boards[0].boardLabel = plan.jobs[1].boardLabel; },
      match: /boardIndex and boardLabel name different required boards/u,
    },
    {
      name: "unknown board label",
      mutate: ({ map }) => { map.boards[1].boardLabel = "存在しない視点"; },
      match: /boardLabel does not exactly match a required board/u,
    },
    {
      name: "empty generator context",
      mutate: ({ map }) => { map.boards[3].generator.contextId = " "; },
      match: /boards\[3\]\.generator\.contextId must name the conversation/u,
    },
    {
      name: "missing importer context",
      mutate: ({ map }) => { map.importedBy.contextId = ""; },
      match: /importedBy host, id, and contextId must be non-empty/u,
    },
    {
      name: "prompt file changed",
      mutate: async ({ sourceDir }) => { await writeFile(join(sourceDir, "continuity-prompt.txt"), "changed\n"); },
      match: /boards\[3\]\.promptSha256 does not match the prompt file/u,
    },
    {
      name: "both prompt forms",
      mutate: ({ map }) => { map.boards[3].promptText = "also inline"; },
      match: /exactly one/u,
    },
    {
      name: "reference role outside the allowlist",
      mutate: ({ map }) => { map.boards[0].referenceImages[0].role = "photo"; },
      match: /role must be one of: anchor, derived, style, other/u,
    },
    {
      name: "other location",
      mutate: ({ map }) => { map.locationId = "sample-cafe"; },
      match: /locationId must be sample-street/u,
    },
  ];
  await withProject("koya-location-import-reject-", async ({ root, authority }) => {
    for (const scenario of cases) {
      const sourceDir = join(root, "sources", scenario.name.replace(/\s+/gu, "-"));
      const prepared = await writeSyntheticImport({ authority, locationId: "sample-street", sourceDir, mutate: scenario.mutate });
      await assert.rejects(
        () => importKoyaLocationBoards({ authority, locationId: "sample-street", importMapPath: prepared.mapPath }),
        (error) => {
          assert.match(error.message, /nothing was written/u, scenario.name);
          assert.match(error.message, scenario.match, scenario.name);
          return true;
        },
        scenario.name,
      );
      const outputFiles = (await listFiles(dirname(prepared.plan.jobs[0].outputPath))).filter((name) => !name.endsWith(".lock"));
      assert.deepEqual(outputFiles, [], `${scenario.name}: 何も書かない`);
    }
  });
});

test("re-import moves differing boards and the older manifest aside, and refuses to replace registered boards", async () => {
  await withProject("koya-location-reimport-", async ({ root, projectDir, authority }) => {
    const locationId = "sample-cafe";
    const first = await writeSyntheticImport({ authority, locationId, sourceDir: join(root, "first") });
    const firstImport = await importKoyaLocationBoards({ authority, locationId, importMapPath: first.mapPath });
    const firstManifestBytes = await readFile(firstImport.manifestPath);
    // 2回目は継続ビュー1枚だけ別の絵にする。
    const second = await writeSyntheticImport({
      authority,
      locationId,
      sourceDir: join(root, "second"),
      mutate: async ({ map, sourceDir }) => {
        const replacement = boardPng("replacement-view-3");
        await writeFile(join(sourceDir, "download-3.png"), replacement);
        map.boards[2].sourceSha256 = sha256(replacement);
      },
    });
    const secondImport = await importKoyaLocationBoards({ authority, locationId, importMapPath: second.mapPath });
    assert.ok(secondImport.superseded.directory.includes("superseded-"));
    assert.deepEqual(secondImport.written, [second.plan.jobs[2].outputPath]);
    // 退避先は join() で組み立てるので、区切りは OS 依存。basename で取り出す。
    const movedNames = secondImport.superseded.moved.map((row) => basename(row.to)).sort();
    assert.deepEqual(movedNames, ["board-3-view-3.png", "location-generation.manifest.json"].sort());
    const movedBoard = secondImport.superseded.moved.find((row) => row.to.endsWith(".png"));
    assert.equal(sha256(await readFile(movedBoard.to)), first.sources[2].sha256, "古いボードは消さずに退避する");
    const movedManifest = secondImport.superseded.moved.find((row) => row.to.endsWith(".json"));
    assert.deepEqual(await readFile(movedManifest.to), firstManifestBytes);
    assert.equal(sha256(await readFile(second.plan.jobs[2].outputPath)), second.map.boards[2].sourceSha256);
    assert.equal(sha256(await readFile(first.sources[2].path)), first.sources[2].sha256, "元ファイルは残る");

    // 承認済みの登録が参照しているボードは差し替えない。
    const registry = await readCharacterRegistry({ projectDir });
    registry.characters.push({
      id: locationId,
      name: "喫茶店・見本",
      kind: "location",
      role: "fixed",
      status: "approved",
      referenceAssets: second.plan.jobs.map((job) => ({ id: job.boardId, role: "supplemental", path: job.outputPath.slice(join(projectDir, "canvas").length + 1) })),
    });
    await writeCharacterRegistry({ projectDir }, registry);
    const manifestBefore = await readFile(secondImport.manifestPath);
    await assert.rejects(
      () => importKoyaLocationBoards({ authority, locationId, importMapPath: first.mapPath }),
      /Approved registry entry sample-cafe still references .*Nothing was written/u,
    );
    assert.deepEqual(await readFile(secondImport.manifestPath), manifestBefore);
    // 別の出力先へなら取り込める（登録は archived にするまで通らない）。
    const elsewhere = join(projectDir, "canvas", "assets", "koya-locations", locationId, "retake");
    const retake = await writeSyntheticImport({ authority, locationId, sourceDir: join(root, "retake"), outputDir: elsewhere });
    const retakeImport = await importKoyaLocationBoards({ authority, locationId, importMapPath: retake.mapPath, outputDir: elsewhere });
    assert.equal(dirname(retakeImport.manifestPath), elsewhere);
    // canvas の外へは取り込まない。
    await assert.rejects(
      () => importKoyaLocationBoards({ authority, locationId, importMapPath: retake.mapPath, outputDir: join(root, "outside") }),
      /inside canvas/u,
    );
  });
});

test("location bible text policy and aliases are validated, and the default path stays unchanged", async () => {
  const valid = syntheticLocationBible();
  assert.equal(validateKoyaLocationBible(valid).pass, true);
  const invalid = [
    [(bible) => { bible.locations[0].textPolicy = "anything-goes"; }, /textPolicy must be one of: none, fictional-signage-allowed/u],
    [(bible) => { bible.locations[0].aliases = "喫茶店"; }, /aliases must be an array/u],
    [(bible) => { bible.locations[0].aliases = [" 喫茶店"]; }, /without surrounding whitespace/u],
    [(bible) => { bible.locations[0].aliases = ["喫茶店", "喫茶店"]; }, /duplicate: 喫茶店/u],
    [(bible) => { bible.locations[0].aliases = [""]; }, /non-empty place names/u],
    [(bible) => { bible.locations[1].aliases.push("喫茶店"); }, /'喫茶店' is claimed by both sample-cafe and sample-street/u],
    [(bible) => { bible.locations[1].aliases.push(bible.locations[0].name); }, /claimed by both/u],
    [(bible) => { bible.locations[0].aliases = Array.from({ length: 21 }, (_, index) => `別名${index}`); }, /at most 20/u],
  ];
  for (const [mutate, pattern] of invalid) {
    const bible = syntheticLocationBible();
    mutate(bible);
    assert.throws(() => validateKoyaLocationBible(bible), pattern);
  }
  // 既定（textPolicy なし）と明示の "none" は同じ扱いで、文面も確認項目も変わらない。
  const explicitNone = syntheticLocationBible();
  explicitNone.locations[0].textPolicy = "none";
  assert.equal(validateKoyaLocationBible(explicitNone).pass, true);
  const fixtureShowBible = JSON.parse(await readFile(join(repositoryRoot, "test/fixtures/channel-pack/config/koya-show-bible.json"), "utf8"));
  const planFor = (bible, locationId) => buildKoyaLocationBoardPlan({ projectDir: "/nonexistent-project", locationBible: bible, showBible: fixtureShowBible, locationId });
  const defaultPlan = planFor(valid, "sample-cafe");
  assert.deepEqual(planFor(explicitNone, "sample-cafe").jobs.map((job) => job.prompt), defaultPlan.jobs.map((job) => job.prompt));
  assert.ok(defaultPlan.jobs.every((job) => job.prompt.endsWith("No people, silhouettes, faces, readable lettering, real logos, or real place names. Preserve navigable spatial continuity across all approved views.")));
  assert.ok(defaultPlan.reviewRequirements.includes("no people, readable text, or real brands"));
  assert.deepEqual(koyaLocationBoardCheckKeys(valid.locations[0]), ["containsPeopleFalse", "readableTextAbsent", "realBrandsAbsent", "architectureLockPass", "originalScalePass"]);
  assert.deepEqual(koyaLocationAnchorCheckKeys(valid.locations[0]), ["containsPeopleFalse", "readableTextAbsent", "realBrandsAbsent", "architectureLockPass", "originalScalePass", "continuitySourceApproved"]);
  const signagePlan = planFor(valid, "sample-street");
  assert.ok(signagePlan.jobs.every((job) => /Shop signs may carry only minimal invented names; no real names, real brands, real logos, or real place names\./u.test(job.prompt)));
  assert.ok(signagePlan.jobs.every((job) => !/readable lettering/u.test(job.prompt)));
  assert.deepEqual(koyaLocationBoardCheckKeys(valid.locations[1]), ["containsPeopleFalse", "readableTextFictionalOnly", "realBrandsAbsent", "architectureLockPass", "originalScalePass"]);
  // 下書きの確認項目も既定の場所では従来のまま。
  const draft = await createKoyaLocationReviewDraft({ projectDir: "/nonexistent-project", locationBible: valid, showBible: fixtureShowBible, locationId: "sample-cafe" });
  assert.deepEqual(draft.boards[0].checks, { containsPeopleFalse: false, readableTextAbsent: false, realBrandsAbsent: false, architectureLockPass: false, originalScalePass: false });
  assert.equal(Object.hasOwn(draft, "anchorApproval"), false);
  assert.equal(draft.instructions, "SHA and dimensions are read from the current planned files. A different reviewer must inspect every image at original scale and change only observed checks to true.");
});

test("the official paid route still registers natively generated boards, with the default text policy", async () => {
  await withProject("koya-location-native-", async ({ projectDir, authority }) => {
    const locationId = "sample-cafe";
    const common = { projectDir, locationBible: authority.locationBible, showBible: authority.showBible, locationId };
    const generator = { host: "codex", id: "location-generator", contextId: "session-generator" };
    let calls = 0;
    const generateImage = async () => { calls += 1; return { buffer: boardPng(`native-${calls}`) }; };
    await generateKoyaLocationBoards({ authority, locationId, stage: "anchor", generator, generateImage });
    const reviewsDir = join(projectDir, "canvas", "reviews");
    await mkdir(reviewsDir, { recursive: true });
    const anchorReview = passAnchorChecks(await createKoyaLocationAnchorReviewDraft(common));
    assert.ok(Object.hasOwn(anchorReview.anchor.checks, "readableTextAbsent"));
    assert.doesNotMatch(anchorReview.instructions, /importer/u);
    anchorReview.reviewer = { host: "claude", id: "anchor-reviewer", contextId: "session-anchor-reviewer" };
    anchorReview.reviewedAt = "2026-09-18T01:00:00.000Z";
    const anchorReviewPath = join(reviewsDir, "cafe-anchor.json");
    await writeFile(anchorReviewPath, `${JSON.stringify(anchorReview, null, 2)}\n`);
    const generated = await generateKoyaLocationBoards({ authority, locationId, stage: "continuity", anchorReviewPath, generator, generateImage });
    assert.equal(generated.complete, true);
    assert.equal(calls, 4);
    // 公式生成の下書きは anchorApproval を持たず、review 側のアンカー承認も受けない。
    const draft = await createKoyaLocationReviewDraft({ ...common, anchorReviewPath });
    assert.equal(Object.hasOwn(draft, "anchorApproval"), false);
    const review = passBoardChecks(draft);
    review.reviewer = { host: "claude", id: "final-reviewer", contextId: "session-final-reviewer" };
    review.reviewedAt = "2026-09-18T02:00:00.000Z";
    const audit = await auditKoyaLocationReview({ ...common, review });
    assert.equal(audit.pass, true, audit.failures.join("\n"));
    assert.equal(audit.anchorApproval.source, "manifest");
    const withReviewApproval = structuredClone(review);
    withReviewApproval.anchorApproval = { path: anchorReviewPath, sha256: "0".repeat(64) };
    assert.match((await auditKoyaLocationReview({ ...common, review: withReviewApproval })).failures.join("\n"), /differs from the anchor approval recorded/u);
    const selfReviewed = structuredClone(review);
    selfReviewed.reviewer.contextId = generator.contextId;
    assert.match((await auditKoyaLocationReview({ ...common, review: selfReviewed })).failures.join("\n"), /different from its generator/u);
    const reviewPath = join(reviewsDir, "cafe-final.json");
    await writeFile(reviewPath, `${JSON.stringify(review, null, 2)}\n`);
    const registered = await registerApprovedKoyaLocation({ authority, projectDir, locationId, reviewPath });
    assert.deepEqual(registered.location.aliases, ["喫茶店"]);
    assert.equal(registered.location.negativePrompt, "people, silhouettes, readable text, real logos, real place names, architecture drift");
    assert.equal(registered.location.approval.reason, "All four SHA-bound environment boards passed independent original-scale and continuity review.");
  });
});

test("the location-import CLI action feeds the official draft, audit and register actions, including a custom output directory", async () => {
  await withProject("koya-location-cli-", async ({ root, projectDir, authority }) => {
    const locationId = "sample-cafe";
    const outputDir = join(projectDir, "canvas", "assets", "koya-locations", locationId, "chat-import");
    const prepared = await writeSyntheticImport({ authority, locationId, sourceDir: join(root, "downloads"), outputDir });
    // 開発機の本物の pack を読まないよう、pack 指定を外して起動する。
    const env = { ...process.env };
    delete env.BUZZASSIST_CHANNEL_PACK;
    delete env.BUZZASSIST_CHANNEL_PACK_ID;
    const run = (...args) => {
      const result = spawnSync(process.execPath, [join(repositoryRoot, "scripts", "koya-manga-video.mjs"), ...args, "--project-dir", projectDir], {
        cwd: root,
        env,
        encoding: "utf8",
        timeout: 120_000,
      });
      return { ...result, json: (() => { try { return JSON.parse(result.stdout); } catch { return null; } })() };
    };
    const imported = run("location-import", "--location-id", locationId, "--import-map-path", prepared.mapPath, "--output-dir", outputDir);
    assert.equal(imported.status, 0, imported.stderr);
    assert.doesNotMatch(imported.stderr, /unknown option/u);
    assert.equal(imported.json.complete, true);
    assert.equal(dirname(imported.json.manifestPath), outputDir);
    const missingMap = run("location-import", "--location-id", locationId);
    assert.notEqual(missingMap.status, 0);
    assert.match(missingMap.stderr, /--import-map-path is required/u);

    const anchorDraft = run("location-anchor-review-draft", "--location-id", locationId, "--output-dir", outputDir);
    assert.equal(anchorDraft.status, 0, anchorDraft.stderr);
    const anchorReview = passAnchorChecks(anchorDraft.json);
    anchorReview.reviewer = { host: "codex", id: "anchor-reviewer", contextId: "session-anchor-reviewer" };
    anchorReview.reviewedAt = "2026-09-18T01:00:00.000Z";
    const reviewsDir = join(projectDir, "canvas", "reviews");
    await mkdir(reviewsDir, { recursive: true });
    const anchorReviewPath = join(reviewsDir, "cafe-anchor.json");
    await writeFile(anchorReviewPath, `${JSON.stringify(anchorReview, null, 2)}\n`);
    const anchorAudit = run("location-anchor-audit", "--location-id", locationId, "--output-dir", outputDir, "--location-anchor-review-path", anchorReviewPath);
    assert.equal(anchorAudit.status, 0, anchorAudit.stdout);
    assert.equal(anchorAudit.json.pass, true);

    const reviewDraft = run("location-review-draft", "--location-id", locationId, "--output-dir", outputDir, "--location-anchor-review-path", anchorReviewPath);
    assert.equal(reviewDraft.status, 0, reviewDraft.stderr);
    assert.equal(reviewDraft.json.anchorApproval.path, anchorReviewPath);
    const review = passBoardChecks(reviewDraft.json);
    review.reviewer = { host: "codex", id: "final-reviewer", contextId: "session-final-reviewer" };
    review.reviewedAt = "2026-09-18T02:00:00.000Z";
    const reviewPath = join(reviewsDir, "cafe-final.json");
    await writeFile(reviewPath, `${JSON.stringify(review, null, 2)}\n`);
    // 登録は --output-dir を取らない。審査済み manifest の場所でアンカー承認を読み直す。
    const registered = run("location-register", "--location-id", locationId, "--location-review-path", reviewPath);
    assert.equal(registered.status, 0, registered.stderr);
    assert.equal(registered.json.reviewPass, true);
    // 登録簿は canvas からの相対パスを OS の区切りで書く。期待値も join で組み立てる。
    assert.equal(
      registered.json.location.referenceAssets[0].path,
      join("assets", "koya-locations", locationId, "chat-import", `${prepared.plan.jobs[0].boardId}.png`),
    );
    assert.ok((await stat(join(projectDir, "canvas", "characters.json"))).isFile());
  });
});

test("importAndRegisterSyntheticLocation helper completes the imported route end to end", async () => {
  await withProject("koya-location-helper-", async ({ root, projectDir, authority }) => {
    const result = await importAndRegisterSyntheticLocation({ projectDir, authority, locationId: "sample-street", sourceDir: join(root, "downloads") });
    assert.equal(result.registered.location.status, "approved");
    assert.equal(result.registered.audit.anchorApproval.source, "review");
  });
});
