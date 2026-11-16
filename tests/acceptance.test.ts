import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm,writeFile,mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkAcceptance } from '../src/acceptance.ts';
test('offline or incomplete evidence cannot pass live acceptance',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'swarm-accept-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  await writeFile(join(dir,'manifest.json'),JSON.stringify({mode:'offline',experiment:{agents:[{id:'a',definition:'merchant'}],durationSeconds:1800}}));
  await writeFile(join(dir,'report.json'),JSON.stringify({status:'completed',elapsedSeconds:1800}));
  const report=await checkAcceptance(dir);
  assert.equal(report.passed,false);
  assert.ok(report.missing.includes('liveRun'));
  assert.ok(report.missing.includes('tenAgents'));
  assert.ok(report.missing.includes('socialSmoke'));
  assert.ok(report.missing.includes('agent:a:request'));
  assert.ok(report.missing.includes('agent:a:memory'));
  assert.ok(report.missing.includes('agent:a:gameAction'));
  assert.ok(report.missing.includes('policyIsolation'));
});
test('malformed event evidence is reported instead of treated as successful',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'swarm-accept-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  await writeFile(join(dir,'manifest.json'),JSON.stringify({worldId:'w',experiment:{agents:[{id:'a',definition:'merchant'}]}}));
  await mkdir(join(dir,'agents/w/a'),{recursive:true});
  await writeFile(join(dir,'agents/w/a/events.jsonl'),'broken\n');
  const report=await checkAcceptance(dir);assert.equal(report.passed,false);assert.ok(report.missing.includes('agent:a:validEvents'));
});

