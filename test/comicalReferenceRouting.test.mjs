import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  normalizeCharacterRegistry, optimizeCharacterBindingsForGeneration, resolveCharacterBindings,
  verifyComicalReferenceBindings,
} from '../lib/characterRegistry.mjs';
import { buildCharacterStoryboardJobs } from '../lib/characterPipeline.mjs';
import { createMangaScriptImagePlan, executeMangaScriptImagePlan, mangaImageQaVisualPrompt, renderEditorialPlatePng } from '../lib/mangaScriptImagePipeline.mjs';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
async function fixture(t, count = 1) {
  const root = await mkdtemp(join(tmpdir(), 'comical-routing-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const canvasDir = join(root, 'canvas');
  await mkdir(canvasDir);
  const characters = [], indexed = [];
  for (let n = 1; n <= count; n++) {
    const refs = [];
    for (const role of ['identity-face', 'turnaround', 'expression', 'eye-open', 'outfit', 'comical-A', 'comical-B']) {
      const path = join(canvasDir, `person-${n}-${role}.png`);
      const bytes = Buffer.from(`fixture ${n} ${role}`);
      await writeFile(path, bytes);
      refs.push({ role, path, sha256: digest(bytes), storyStage: role === 'outfit' ? 'winter' : '', ...(role.startsWith('comical') ? { use: 'supplemental-expression-reference' } : {}) });
    }
    const id = `person-${n}`, name = `人物${n}号`;
    characters.push({ id, name, status: 'approved', referenceAssets: refs.slice(0, 5), approval: { approvedBy: 'fixture-client' } });
    indexed.push({ id, name, status: 'approved', references: refs });
  }
  const registry = normalizeCharacterRegistry({ characters });
  const registryPath = join(canvasDir, 'characters.json');
  await writeFile(registryPath, JSON.stringify(registry));
  const index = { characters: indexed }, indexPath = join(canvasDir, 'production-reference-index.json');
  const saveIndex = () => writeFile(indexPath, JSON.stringify(index));
  await saveIndex();
  const bindings = resolveCharacterBindings(registry, characters.map(c => c.id), { canvasDir });
  const route = (intent = 'comical-A', selected = bindings, extra = {}) => optimizeCharacterBindingsForGeneration(selected, { referenceIntent: intent, productionReferenceIndexPath: indexPath, ...extra });
  return { root, canvasDir, registry, registryPath, index, indexPath, saveIndex, bindings, route };
}
function planFor(f, referenceIntent = 'comical-A', count = 1) {
  const cast = f.registry.characters.slice(0, count);
  return createMangaScriptImagePlan({
    episodeId: `fixture-${referenceIntent}-${count}`,
    scriptText: `【カット1：店内】\n${cast.map(c => c.name).join('と')}：驚いた！`,
    // Explicit parsed cast keeps this test independent of script name heuristics.
    parsed: { title: 'fixture', utterances: [{ id: 'cut-01-u01', cutId: 'cut-01', speakerId: cast[0].id, speakerName: cast[0].name, text: '驚いた！', preset: 'speech' }],
      cuts: [{ id: 'cut-01', title: '店内', purpose: cast.map(c => c.name).join('と'), utterances: [{ id: 'cut-01-u01', cutId: 'cut-01', speakerId: cast[0].id, speakerName: cast[0].name, text: '驚いた！', preset: 'speech' }] }] },
    registry: f.registry, canvasDir: f.canvasDir, assetDir: join(f.canvasDir, 'assets', `fixture-${referenceIntent}-${count}`),
    visualPlanOverrides: { productionReferenceIndexPath: f.indexPath, byUtterance: { 'cut-01-u01': { referenceIntent, disableEditorialPlate: true } } },
  });
}
const output = () => ({ buffer: renderEditorialPlatePng('white-solid'), model: 'stub' });

test('all 11 x A/B use explicit supplemental art plus approved identity without mutating approval', async t => {
  const f = await fixture(t, 11), before = JSON.stringify(f.registry);
  for (const binding of f.bindings) for (const intent of ['comical-A', 'comical-B']) {
    const [routed] = f.route(intent, [binding]);
    const indexRow = f.index.characters.find(c => c.id === binding.id);
    assert.deepEqual(routed.referenceImagePaths, [binding.referenceAssets[0].path, indexRow.references.find(a => a.role === intent).path]);
    assert.deepEqual(routed.referenceAssets.map(a => a.role), ['identity-face', intent]);
    assert.equal(verifyComicalReferenceBindings([routed])[0], routed);
  }
  assert.equal(JSON.stringify(f.registry), before);
  assert.equal(await readFile(f.registryPath, 'utf8'), before);
  assert.throws(() => f.route('comical-A', f.bindings, { providerReferenceLimit: 21 }), /require 22 images/);
  assert.equal(f.route('comical-B', f.bindings, { providerReferenceLimit: 22 }).length, 11);
});

for (const scenario of ['missing-index', 'invalid-index', 'missing-entry', 'duplicate-entry', 'unapproved-entry', 'missing-A', 'duplicate-A', 'wrong-use', 'missing-SHA', 'stale-SHA', 'missing-art', 'stale-identity', 'missing-identity-art']) {
  test(`comical routing rejects ${scenario} without falling back to ordinary expression`, async t => {
    const f = await fixture(t), row = f.index.characters[0], art = row.references.find(a => a.role === 'comical-A');
    if (scenario === 'missing-index') await rm(f.indexPath);
    else if (scenario === 'invalid-index') await writeFile(f.indexPath, '{');
    else {
      if (scenario === 'missing-entry') f.index.characters = [];
      if (scenario === 'duplicate-entry') f.index.characters.push(row);
      if (scenario === 'unapproved-entry') row.status = 'draft';
      if (scenario === 'missing-A') row.references = row.references.filter(a => a !== art);
      if (scenario === 'duplicate-A') row.references.push(art);
      if (scenario === 'wrong-use') art.use = 'identity';
      if (scenario === 'missing-SHA') delete art.sha256;
      if (scenario === 'stale-SHA') await writeFile(art.path, 'changed art');
      if (scenario === 'missing-art') await rm(art.path);
      if (scenario === 'stale-identity') row.references[0].sha256 = '0'.repeat(64);
      if (scenario === 'missing-identity-art') await rm(row.references[0].path);
      await f.saveIndex();
    }
    assert.throws(() => f.route(), /index|SHA-256|supplemental|missing|unreadable/);
  });
}

test('requires explicit valid A/B, an approved identity binding and an explicit index', async t => {
  const f = await fixture(t);
  assert.throws(() => f.route('comical'), /use comical-A or comical-B/);
  assert.throws(() => f.route('comical-C'), /use comical-A or comical-B/);
  assert.throws(() => f.route('comical-A', []), /approved character bindings/);
  assert.throws(() => f.route('comical-A', [{ ...f.bindings[0], status: 'draft' }]), /approved entry/);
  assert.throws(() => f.route('comical-A', f.bindings, { productionReferenceIndexPath: '' }), /requires productionReferenceIndexPath/);
  assert.throws(() => f.route('comical-A', [{ ...f.bindings[0], referenceAssets: f.bindings[0].referenceAssets.slice(1) }]), /stale approved identity/);
});

test('normal and other-channel routes ignore supplemental indexes and keep existing selection', async t => {
  const f = await fixture(t, 2);
  await rm(f.indexPath);
  for (const [intent, expected] of [['default', []], ['closeup', ['expression']], ['expression', ['expression']], ['full-body', ['turnaround']], ['profile', ['turnaround']], ['eye-open', ['eye-open']], ['outfit', ['outfit']]]) {
    assert.deepEqual(f.route(intent, f.bindings.slice(0, 1))[0].referenceAssets.map(a => a.role), ['identity-face', ...expected]);
  }
  assert.deepEqual(f.route('profile').map(b => b.referenceAssets.map(a => a.role)), [['identity-face'], ['identity-face']]);
  assert.equal(f.route('default', f.bindings.slice(0, 1), { storyStage: 'winter' })[0].referenceAssets[1].role, 'outfit');
  assert.throws(() => f.route('outfit', f.bindings.slice(0, 1), { storyStage: 'missing' }), /no approved outfit/);
});

test('production plan sends A/B to actual generator arguments; retries retain both and cache hash binds art SHA', async t => {
  const f = await fixture(t, 2);
  for (const intent of ['comical-A', 'comical-B']) {
    const plan = planFor(f, intent, 2), calls = [];
    const job = plan.jobs.find(j => j.kind === 'scene-image');
    assert.equal(job.comicalBindings.length, 2);
    assert.equal(job.referenceImagePaths.length, 5);
    const qaPrompt = mangaImageQaVisualPrompt({ job, outputPath: job.outputPath });
    assert.match(qaPrompt, /attachment 2 after the candidate = 人物1号 comical-[AB] supplemental/);
    assert.match(qaPrompt, /attachment 3 after the candidate = 人物2号 approved identity/);
    if (intent === 'comical-B') assert.match(qaPrompt, /chibi proportions are intentional/);
    let sceneQaCalls = 0;
    const result = await executeMangaScriptImagePlan(plan, {
      concurrency: 1, maxRetries: 1,
      generateImage: async input => { calls.push(input); return output(); },
      visualQa: async ({ job: item }) => item.kind === 'scene-image' && sceneQaCalls++ === 0
        ? { pass: false, score: 50, issues: ['fix facial reaction'], hardFailures: ['reaction'] }
        : { pass: true, score: 99, issues: [], hardFailures: [] },
    });
    assert.equal(result.ledger.status, 'complete');
    const sceneCalls = calls.filter(c => c.fileName === job.outputPath.split('/').at(-1));
    assert.equal(sceneCalls.length, 2);
    for (const call of sceneCalls) {
      assert.deepEqual(call.referenceImagePaths, job.referenceImagePaths);
      assert.match(call.prompt, new RegExp(`${intent} supplemental expression art`));
      assert.match(call.prompt, /Reference image 3 locks/);
    }
    const oldHash = job.inputHash, art = f.index.characters[0].references.find(a => a.role === intent);
    await writeFile(art.path, `new ${intent}`); art.sha256 = digest(`new ${intent}`); await f.saveIndex();
    assert.notEqual(planFor(f, intent, 2).jobs.find(j => j.kind === 'scene-image').inputHash, oldHash);
  }
});

test('missing/stale files and changed index after planning stop before any provider invocation, including reuse', async t => {
  const f = await fixture(t), plan = planFor(f), art = f.index.characters[0].references.find(a => a.role === 'comical-A');
  let calls = 0;
  await writeFile(art.path, 'stale after planning');
  await assert.rejects(executeMangaScriptImagePlan(plan, { generateImage: async () => { calls++; return output(); } }), /stale SHA-256/);
  assert.equal(calls, 0);
  await writeFile(art.path, 'fixture 1 comical-A');
  await f.saveIndex();
  f.index.source = 'new snapshot'; await f.saveIndex();
  await assert.rejects(executeMangaScriptImagePlan(plan, { generateImage: async () => { calls++; return output(); } }), /stale SHA-256/);
  assert.equal(calls, 0);
});

test('provider fallback cannot silently drop comical art to fit three references', async t => {
  const f = await fixture(t, 3);
  assert.throws(() => planFor(f, 'comical-A', 3), /require 6 images/);
  const plan = planFor(f, 'comical-A', 2), calls = [];
  const result = await executeMangaScriptImagePlan(plan, {
    concurrency: 1, maxRetries: 0, autoSemanticQa: false, fallbackImageModel: 'grok-imagine-image-hermes',
    generateImage: async input => { calls.push(input); if (input.fileName.startsWith('cut-')) throw new Error('usage limit reached'); return output(); },
  });
  assert.equal(result.ledger.status, 'failed');
  assert.equal(calls.filter(c => c.model === 'grok-imagine-image-hermes').length, 0);
  assert.match(JSON.stringify(result.ledger), /comical identity and supplemental references/);
});

test('storyboard and real MCP provider payload preview carry explicit A/B with SHA checks', async t => {
  const f = await fixture(t);
  const workflow = { id: 'fixture', episodeId: 'fixture', cast: [{ id: 'person-1', characterId: 'person-1', name: '人物1号', aliases: [], status: 'ready' }], model: 'nano-banana-2' };
  const jobs = buildCharacterStoryboardJobs(workflow, ['comical-A', 'comical-B'].map(referenceIntent => ({ prompt: '人物1号の驚き', characterIds: ['person-1'], referenceIntent, productionReferenceIndexPath: f.indexPath })));
  assert.equal(jobs[1].productionReferenceIndexPath, f.indexPath);
  const client = new Client({ name: 'comical-routing-test', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [resolve('mcp/server.mjs')], cwd: resolve('.'), env: { ...process.env, CODEX: '1', EXCALIDRAW_NO_AUTO_OPEN: '1', EXCALIDRAW_PROJECT_DIR: f.root, EXCALIDRAW_CANVAS_DIR: f.canvasDir }, stderr: 'pipe' });
  try {
    await client.connect(transport);
    const call = () => client.callTool({ name: 'generate_excalidraw_images_batch', arguments: { projectDir: f.root, canvasDir: f.canvasDir, payloadPreview: true, jobs } });
    const result = await call();
    assert.equal(result.isError, undefined, JSON.stringify(result));
    for (const [n, intent] of ['comical-A', 'comical-B'].entries()) {
      assert.deepEqual(result.structuredContent.results[n].body.image_urls, ['https://preview.invalid/image/person-1-identity-face.png', `https://preview.invalid/image/person-1-${intent}.png`]);
      assert.match(result.structuredContent.results[n].body.prompt, new RegExp(`${intent} supplemental expression art`));
    }
    await writeFile(f.index.characters[0].references.find(a => a.role === 'comical-B').path, 'changed');
    const stale = await call();
    assert.equal(stale.isError, true);
    assert.match(stale.content[0].text, /stale SHA-256/);
  } finally { await client.close(); await transport.close(); }
});
