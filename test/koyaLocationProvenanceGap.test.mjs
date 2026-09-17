// 記録が最初から残っていない背景ボードを、作り話のプロンプトで埋めずに
// 「欠落」として宣言し、独立した審査者の確認が付いたときだけ通す経路。
// 場所・会話・審査者はすべて架空の汎用名。
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  auditKoyaLocationAnchorReview,
  auditKoyaLocationReview,
  createKoyaLocationAnchorReviewDraft,
  createKoyaLocationReviewDraft,
  importKoyaLocationBoards,
  registerApprovedKoyaLocation,
} from "../lib/koyaChannelGovernance.mjs";
import { readCharacterRegistry } from "../lib/characterRegistry.mjs";
import {
  SPECIFICATION_TEXT,
  declareProvenanceGap,
  importAndRegisterSyntheticLocation,
  installSyntheticKoyaAuthority,
  passAnchorChecks,
  passBoardChecks,
  readJson,
  sha256,
  writeSyntheticImport,
} from "./helpers/koyaLocationFixture.mjs";

const LOCATION_ID = "sample-cafe";
const ACKNOWLEDGEMENT = "provenanceGapAcknowledged";

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

function commonOptions({ projectDir, authority }) {
  return { projectDir, locationBible: authority.locationBible, showBible: authority.showBible, locationId: LOCATION_ID, outputDir: "" };
}

/** 取り込みだけ済ませ、審査の書き換えを試せる状態にする。 */
async function importWithGap({ root, projectDir, authority, mutate }) {
  const sourceDir = join(root, "downloads");
  const prepared = await writeSyntheticImport({ authority, locationId: LOCATION_ID, sourceDir, mutate });
  const imported = await importKoyaLocationBoards({ authority, locationId: LOCATION_ID, importMapPath: prepared.mapPath, outputDir: "" });
  const reviewsDir = join(projectDir, "canvas", "reviews");
  await mkdir(reviewsDir, { recursive: true });
  return { prepared, imported, reviewsDir, sourceDir };
}

async function passedAnchorReview({ common, reviewsDir }) {
  const anchorReview = passAnchorChecks(await createKoyaLocationAnchorReviewDraft(common));
  anchorReview.reviewer = { host: "codex", id: "anchor-reviewer", contextId: "session-anchor-reviewer" };
  anchorReview.reviewedAt = "2026-09-18T01:00:00.000Z";
  const anchorReviewPath = join(reviewsDir, `${LOCATION_ID}-anchor.json`);
  await writeFile(anchorReviewPath, `${JSON.stringify(anchorReview, null, 2)}\n`);
  return { anchorReview, anchorReviewPath };
}

async function finalReview({ common, reviewsDir, anchorReviewPath, mutateReview = null }) {
  const review = passBoardChecks(await createKoyaLocationReviewDraft({ ...common, anchorReviewPath }));
  review.reviewer = { host: "codex", id: "final-reviewer", contextId: "session-final-reviewer" };
  review.reviewedAt = "2026-09-18T02:00:00.000Z";
  if (mutateReview) mutateReview(review);
  const reviewPath = join(reviewsDir, `${LOCATION_ID}-final.json`);
  await writeFile(reviewPath, `${JSON.stringify(review, null, 2)}\n`);
  return { review, reviewPath };
}

test("a board whose prompt and conversation were never recorded is imported as a declared gap, not as an invented prompt", async () => {
  await withProject("koya-gap-import-", async ({ root, projectDir, authority }) => {
    const sourceDir = join(root, "downloads");
    const registered = await importAndRegisterSyntheticLocation({
      projectDir,
      authority,
      locationId: LOCATION_ID,
      sourceDir,
      mutate: declareProvenanceGap({ boardNumber: 2 }),
    });
    const manifest = await readJson(registered.imported.manifestPath);
    const [complete, gapped] = manifest.entries;

    // 欠落を宣言したボード: プロンプト SHA を作らない、会話 id を持たない、
    // 代わりに理由と「満たすべき文書」の SHA を逐語で残す。
    assert.equal(gapped.promptSha256, "");
    assert.equal(Object.hasOwn(gapped.generator, "contextId"), false);
    assert.equal(gapped.generator.host, "chat-web-image-tool");
    assert.equal(Object.hasOwn(gapped.import, "promptText"), false);
    assert.equal(Object.hasOwn(gapped.import, "promptPath"), false);
    assert.deepEqual(gapped.import.provenanceGap, {
      promptRecorded: false,
      generatorContextRecorded: false,
      reason: "このボードはプロンプトと会話 id を残す決まりより前に作られ、どちらも残っていない",
      specificationPath: join(sourceDir, "set-plan.md"),
      specificationSha256: sha256(SPECIFICATION_TEXT),
    });

    // 記録のあるボードは従来のまま。
    assert.equal(Object.hasOwn(complete.import, "provenanceGap"), false);
    assert.equal(complete.promptSha256, sha256(complete.import.promptText));
    assert.ok(complete.generator.contextId);

    // 審査の下書きは、欠落のあるボードにだけ確認項目を足す。
    const draft = registered.review;
    assert.equal(Object.hasOwn(draft.boards[0].checks, ACKNOWLEDGEMENT), false);
    assert.equal(draft.boards[1].checks[ACKNOWLEDGEMENT], true);
    assert.match(draft.instructions, /provenance gap/u);
    assert.ok(draft.instructions.includes(join(sourceDir, "set-plan.md")));

    // 台帳の承認に、どのボードを欠落のまま登録したかが残る。
    const registry = await readCharacterRegistry({ projectDir });
    const entry = registry.characters.find((character) => character.id === LOCATION_ID);
    assert.deepEqual(entry.approval.provenanceGaps, [{
      boardId: gapped.boardId,
      reason: "このボードはプロンプトと会話 id を残す決まりより前に作られ、どちらも残っていない",
      specificationSha256: sha256(SPECIFICATION_TEXT),
    }]);
    assert.match(entry.approval.reason, /provenance gap/u);
  });
});

test("the anchor audit fails when the gap acknowledgement is missing or false", async () => {
  await withProject("koya-gap-anchor-", async ({ root, projectDir, authority }) => {
    await importWithGap({ root, projectDir, authority, mutate: declareProvenanceGap({ boardNumber: 1 }) });
    const common = commonOptions({ projectDir, authority });
    const draft = await createKoyaLocationAnchorReviewDraft(common);
    assert.equal(draft.anchor.checks[ACKNOWLEDGEMENT], false);
    assert.match(draft.instructions, /provenance gap/u);

    const base = () => {
      const review = passAnchorChecks(JSON.parse(JSON.stringify(draft)));
      review.reviewer = { host: "codex", id: "anchor-reviewer", contextId: "session-anchor-reviewer" };
      review.reviewedAt = "2026-09-18T01:00:00.000Z";
      return review;
    };
    assert.equal((await auditKoyaLocationAnchorReview({ ...common, review: base() })).pass, true);

    const unacknowledged = base();
    unacknowledged.anchor.checks[ACKNOWLEDGEMENT] = false;
    const falseAudit = await auditKoyaLocationAnchorReview({ ...common, review: unacknowledged });
    assert.equal(falseAudit.pass, false);
    assert.ok(falseAudit.failures.some((failure) => failure.includes(`'${ACKNOWLEDGEMENT}' must be true`)));

    const dropped = base();
    delete dropped.anchor.checks[ACKNOWLEDGEMENT];
    const droppedAudit = await auditKoyaLocationAnchorReview({ ...common, review: dropped });
    assert.equal(droppedAudit.pass, false);
    assert.ok(droppedAudit.failures.some((failure) => failure.includes(`'${ACKNOWLEDGEMENT}' must be true`)));
  });
});

test("the final audit and registration fail when the gap acknowledgement is missing or false", async () => {
  await withProject("koya-gap-final-", async ({ root, projectDir, authority }) => {
    const { reviewsDir } = await importWithGap({ root, projectDir, authority, mutate: declareProvenanceGap({ boardNumber: 2 }) });
    const common = commonOptions({ projectDir, authority });
    const { anchorReviewPath } = await passedAnchorReview({ common, reviewsDir });

    const passing = await finalReview({ common, reviewsDir, anchorReviewPath });
    assert.equal((await auditKoyaLocationReview({ ...common, review: passing.review })).pass, true);

    for (const [label, mutateReview] of [
      ["false", (review) => { review.boards[1].checks[ACKNOWLEDGEMENT] = false; }],
      ["missing", (review) => { delete review.boards[1].checks[ACKNOWLEDGEMENT]; }],
    ]) {
      const broken = await finalReview({ common, reviewsDir, anchorReviewPath, mutateReview });
      const audit = await auditKoyaLocationReview({ ...common, review: broken.review });
      assert.equal(audit.pass, false, label);
      assert.ok(audit.failures.some((failure) => failure.includes(`'${ACKNOWLEDGEMENT}' must be true`)), label);
      await assert.rejects(
        () => registerApprovedKoyaLocation({ authority, projectDir, locationId: LOCATION_ID, reviewPath: broken.reviewPath }),
        new RegExp(`'${ACKNOWLEDGEMENT}' must be true`, "u"),
        label,
      );
    }
  });
});

test("the gap acknowledgement is rejected on a board that has complete provenance", async () => {
  await withProject("koya-gap-misplaced-", async ({ root, projectDir, authority }) => {
    const { reviewsDir } = await importWithGap({ root, projectDir, authority, mutate: null });
    const common = commonOptions({ projectDir, authority });

    const anchorDraft = passAnchorChecks(await createKoyaLocationAnchorReviewDraft(common));
    anchorDraft.reviewer = { host: "codex", id: "anchor-reviewer", contextId: "session-anchor-reviewer" };
    anchorDraft.reviewedAt = "2026-09-18T01:00:00.000Z";
    assert.equal(Object.hasOwn(anchorDraft.anchor.checks, ACKNOWLEDGEMENT), false);
    const anchorReviewPath = join(reviewsDir, `${LOCATION_ID}-anchor.json`);
    await writeFile(anchorReviewPath, `${JSON.stringify(anchorDraft, null, 2)}\n`);
    assert.equal((await auditKoyaLocationAnchorReview({ ...common, review: anchorDraft })).pass, true);

    const sprinkledAnchor = JSON.parse(JSON.stringify(anchorDraft));
    sprinkledAnchor.anchor.checks[ACKNOWLEDGEMENT] = true;
    const anchorAudit = await auditKoyaLocationAnchorReview({ ...common, review: sprinkledAnchor });
    assert.equal(anchorAudit.pass, false);
    assert.ok(anchorAudit.failures.some((failure) => failure.includes("only for a board that declares a provenance gap")));

    const sprinkled = await finalReview({
      common,
      reviewsDir,
      anchorReviewPath,
      mutateReview: (review) => { review.boards[2].checks[ACKNOWLEDGEMENT] = true; },
    });
    const audit = await auditKoyaLocationReview({ ...common, review: sprinkled.review });
    assert.equal(audit.pass, false);
    assert.ok(audit.failures.some((failure) => failure.includes("only for a board that declares a provenance gap")));
    await assert.rejects(
      () => registerApprovedKoyaLocation({ authority, projectDir, locationId: LOCATION_ID, reviewPath: sprinkled.reviewPath }),
      /only for a board that declares a provenance gap/u,
    );
  });
});

test("the import map rejects a mixed board, a gap that claims a record exists, unknown gap keys and a wrong specification SHA", async () => {
  const cases = [
    {
      name: "prompt and gap together",
      mutate: declareProvenanceGap({ override: ({ board }) => { board.promptText = "invented after the fact"; } }),
      expected: /records both a prompt and a provenanceGap/u,
    },
    {
      name: "gap plus a generator contextId",
      mutate: declareProvenanceGap({ override: ({ board }) => { board.generator.contextId = "https://chat.example.invalid/c/other"; } }),
      expected: /generator\.contextId is recorded even though/u,
    },
    {
      name: "gap claiming the prompt was recorded",
      mutate: declareProvenanceGap({ override: ({ board }) => { board.provenanceGap.promptRecorded = true; } }),
      expected: /promptRecorded and generatorContextRecorded must both be false/u,
    },
    {
      name: "gap claiming the conversation was recorded",
      mutate: declareProvenanceGap({ override: ({ board }) => { board.provenanceGap.generatorContextRecorded = true; } }),
      expected: /promptRecorded and generatorContextRecorded must both be false/u,
    },
    {
      name: "unknown key inside the gap",
      mutate: declareProvenanceGap({ override: ({ board }) => { board.provenanceGap.promptSha256 = sha256("invented"); } }),
      expected: /provenanceGap has unknown key\(s\): promptSha256/u,
    },
    {
      name: "empty reason",
      mutate: declareProvenanceGap({ override: ({ board }) => { board.provenanceGap.reason = "   "; } }),
      expected: /provenanceGap\.reason must say/u,
    },
    {
      name: "specification SHA that does not match the file",
      mutate: declareProvenanceGap({ override: ({ board }) => { board.provenanceGap.specificationSha256 = sha256("a different specification"); } }),
      expected: /provenanceGap\.specificationSha256 does not match the specification file/u,
    },
    {
      name: "specification file that does not exist",
      mutate: declareProvenanceGap({ writeSpecification: false }),
      expected: /provenanceGap\.specificationPath cannot be read/u,
    },
  ];
  for (const testCase of cases) {
    await withProject("koya-gap-reject-", async ({ root, projectDir, authority }) => {
      const sourceDir = join(root, "downloads");
      const prepared = await writeSyntheticImport({ authority, locationId: LOCATION_ID, sourceDir, mutate: testCase.mutate });
      await assert.rejects(
        () => importKoyaLocationBoards({ authority, locationId: LOCATION_ID, importMapPath: prepared.mapPath, outputDir: "" }),
        testCase.expected,
        testCase.name,
      );
      // 何も書かない。
      await assert.rejects(() => readFile(join(prepared.plan.jobs[0].outputPath)), /ENOENT/u, testCase.name);
    });
  }
});
