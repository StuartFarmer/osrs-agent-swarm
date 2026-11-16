import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,mkdir,writeFile,readFile,rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { prepareWorld,stopOwned,patchLoopback } from '../src/world.ts';
test('creating a world refuses existing saves and invalid identifiers',async t=>{
  const root=await mkdtemp(join(tmpdir(),'swarm-world-'));t.after(()=>rm(root,{recursive:true,force:true}));
  await mkdir(join(root,'.local/worlds/m1/game'),{recursive:true});
  await writeFile(join(root,'.local/worlds/m1/game/save'),'keep');
  await assert.rejects(prepareWorld('m1',root),/exist/);
  assert.equal(await readFile(join(root,'.local/worlds/m1/game/save'),'utf8'),'keep');
  await assert.rejects(prepareWorld('../escape',root),/identifier/);
});
test('process ownership check refuses to signal an unrelated PID',async()=>{
  await assert.rejects(stopOwned({pid:process.pid,token:'not-my-process',script:'/not/a/worker'}),/ownership/);
});
test('loopback patch fails closed on unexpected source and leaves originals intact',()=>{
  assert.equal(patchLoopback("host: '0.0.0.0'",1),"host: '127.0.0.1'");
  assert.throws(()=>patchLoopback("host: 'localhost'",1),/pin/);
});

