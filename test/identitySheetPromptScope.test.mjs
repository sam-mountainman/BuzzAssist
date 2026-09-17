import test from 'node:test';
import assert from 'node:assert/strict';
import {buildChannelVisualStylePrompt} from '../lib/channelVisualProfile.mjs';
import {buildEyeOpenVariantJob,buildApprovedIdentityPackRepairJobs} from '../lib/characterPipeline.mjs';

test('setting sheets retain rendering and identity style without inheriting story framing',()=>{
 const profile={id:'fixture',stylePrompt:'thin manga lines',compositionPrompt:'STORY_COMPOSITION',shotRhythmPrompt:'SHOT_RHYTHM',continuityPrompt:'same identity',outputPrompt:'FULL_BLEED_STORY',negativePrompt:'no realism'};
 for(const tag of ['turnaround','expression-sheet','outfit-sheet']){
  const sheet=buildChannelVisualStylePrompt(profile,{styleTags:[tag]});
  assert.match(sheet,/thin manga lines/);assert.match(sheet,/same identity/);
  assert.doesNotMatch(sheet,/STORY_COMPOSITION|SHOT_RHYTHM|FULL_BLEED_STORY/);
 }
 const story=buildChannelVisualStylePrompt(profile,{styleTags:['dialogue']});
 assert.match(story,/STORY_COMPOSITION/);assert.match(story,/SHOT_RHYTHM/);assert.match(story,/FULL_BLEED_STORY/);
});

test('findings-bound repairs reference the failed sheet and isolate edit instructions from fresh generation layout',()=>{
 const w={id:'wf',model:'fixture',aspectRatio:'16:9',imageSize:'2K',quality:'high'};
 const c={id:'cast',name:'Fixture',description:'Adult',invariants:[],stylePrompt:'OLD_CANDIDATE_CARD_LAYOUT',identityPack:{expression:{assetFile:'/failed-expression.png'}}};
 const findings=[{role:'expression',findingId:'right-profile',problem:'Wrong facing direction',repair:'Nose must point canvas RIGHT.'}];
 const plan={digest:'fixture',entries:[{findingId:'right-profile',repairRegion:[0.25,0.66,0.25,0.34]}]};
 const jobs=buildApprovedIdentityPackRepairJobs(w,c,{assetFile:'/approved.png'},['expression'],{repairId:'r1',repairFindings:findings,repairPlan:plan});
 assert.equal(jobs.length,1);const j=jobs[0];
 assert.deepEqual(j.referenceImagePaths,['/approved.png','/failed-expression.png']);
 assert.match(j.prompt,/reference image 2 is the existing expression sheet/);
 assert.match(j.prompt,/Nose must point canvas RIGHT/);
 assert.doesNotMatch(j.prompt,/OLD_CANDIDATE_CARD_LAYOUT/);
 assert.equal(j.pipeline.identityRepairSourcePath,'/failed-expression.png');
 assert.throws(()=>buildApprovedIdentityPackRepairJobs(w,{...c,identityPack:{}},{assetFile:'/approved.png'},['expression'],{repairId:'r1',repairFindings:findings,repairPlan:plan}),/no staged source image/);
});

test('eye-open variants preserve individual expression direction without imposing a threatening gaze',()=>{
 const w={model:'fixture',aspectRatio:'16:9',imageSize:'2K',quality:'high'};
 for(const expression of ['Relaxed half-open lids and a knowing smirk.','An explicitly approved stern gaze.']){
  const job=buildEyeOpenVariantJob(w,{id:'fixture',name:'Fixture',description:'Adult with closed slit eyes',invariants:[],stylePrompt:expression},{assetFile:'/fixture.png'});
  assert.match(job.prompt,/LEFT COLUMN = DEFAULT STATE/);assert.ok(job.prompt.includes(expression));
  assert.doesNotMatch(job.prompt,/sharp, intense, frightening, dead-serious/);
  assert.match(job.prompt,/four equal cells/);assert.deepEqual(job.referenceImagePaths,['/fixture.png']);
 }
});
