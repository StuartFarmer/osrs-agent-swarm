import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Store } from '../src/store.ts';
const alice = { runId:'r',worldId:'w',agentId:'alice' };
const bob = { ...alice, agentId:'bob' };
const memory = { plan:['trade'],beliefs:[],relationships:{},nextAction:'observe' };
test('memory is private, revisioned, strict, bounded and durable across a fresh process', t => {
  const dir = mkdtempSync(join(tmpdir(), 'swarm-store-'));
  t.after(() => rmSync(dir,{recursive:true,force:true}));
  const path = join(dir,'state.sqlite');
  const store = new Store(path);
  assert.equal(store.updateMemory(alice,0,memory,'agent').revision,1);
  assert.deepEqual(store.readMemory(bob).value.plan,[]);
  assert.throws(() => store.updateMemory(alice,0,memory,'operator'),/revision/);
  assert.throws(() => store.updateMemory(alice,1,{...memory,coins:100} as any,'agent'),/fields/);
  assert.throws(() => store.updateMemory(alice,1,{...memory,plan:['x'.repeat(17000)]},'agent'),/size/);
  assert.equal(store.events(alice,0,50).filter(e=>e.type==='memory_updated').length,1);
  store.beginAction(alice,'trade1',{kind:'trade_accept'});
  store.close();
  const child = spawnSync(process.execPath,['--input-type=module','-e',
    `import {Store} from ${JSON.stringify(new URL('../src/store.ts',import.meta.url).href)};
    const s=new Store(${JSON.stringify(path)});
    process.stdout.write(JSON.stringify([s.readMemory(${JSON.stringify(alice)}),s.pendingActions(${JSON.stringify(alice)})]));s.close();`],{encoding:'utf8'});
  assert.equal(child.status,0,child.stderr);
  const [saved,pending] = JSON.parse(child.stdout);
  assert.equal(saved.revision,1);
  assert.equal(pending[0].actionId,'trade1');
});
test('unknown usage retains reservations and settled requests cannot be charged twice', t => {
  const s = new Store(':memory:'); t.after(()=>s.close());
  s.reserve(alice,'a',0.6,1); s.settle('a',null);
  assert.throws(()=>s.reserve(bob,'b',0.5,1),/budget/);
  s.settle('a',0.2); s.settle('a',0.2);
  assert.equal(s.spending(),0.2);
  s.reserve(bob,'b',0.5,1);
  assert.equal(s.spending(),0.7);
  assert.throws(()=>s.reserve(alice,'c',NaN,1));
});
test('action intent is scoped and uncertain outcomes remain visible on resume', t => {
  const s = new Store(':memory:'); t.after(()=>s.close());
  s.beginAction(alice,'a',{kind:'drop'});
  assert.throws(()=>s.endAction(bob,'a',{status:'completed',message:'ok',evidence:null}),/action/);
  s.endAction(alice,'a',{status:'uncertain',message:'disconnected',evidence:null});
  assert.equal(s.pendingActions(alice).length,1);
  assert.equal(s.pendingActions(bob).length,0);
});

