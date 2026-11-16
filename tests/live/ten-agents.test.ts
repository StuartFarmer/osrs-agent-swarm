import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readWorld,writeJson } from '../../src/world.ts';
import { readManifest,runDirectory,verifyRuntime } from '../../src/run.ts';
import { checkAcceptance } from '../../src/acceptance.ts';

test('validate preserved evidence from an operated 30-minute ten-agent run',{
  skip:process.env.SWARM_LIVE_GAME!=='1'||process.env.SWARM_LIVE_LLM!=='1'||!process.env.SWARM_LIVE_RUN_ID?
    'requires explicit live flags and SWARM_LIVE_RUN_ID from the CLI experiment':false,
},async()=>{
  verifyRuntime();
  const id=process.env.SWARM_LIVE_RUN_ID!,manifest=await readManifest(id),dir=runDirectory(id);
  assert.ok(manifest.experiment.model,'explicit model/budget required');
  assert.equal(manifest.experiment.agents.length,10);
  const smoke=await readWorld(process.env.SWARM_SMOKE_WORLD??'m1smoke');
  await copyFile(join(smoke.dir,'social-smoke.json'),join(dir,'social-smoke.json'));
  const policy=spawnSync(process.execPath,['--import','tsx','--test','tests/agent-definition.test.ts'],{encoding:'utf8'});
  await writeJson(join(dir,'policy-check.json'),{command:'node --import tsx --test tests/agent-definition.test.ts',
    exitCode:policy.status,node:process.versions.node,stdout:policy.stdout,stderr:policy.stderr});
  assert.equal(policy.status,0,policy.stderr);
  const acceptance=await checkAcceptance(dir);
  assert.equal(acceptance.passed,true,'Missing evidence: '+acceptance.missing.join(', '));
});

