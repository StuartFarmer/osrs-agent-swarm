import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureTabs } from '../src/browser.ts';
test('restarting client management reuses existing tabs; partial startup closes only new tabs',async()=>{
  const urls=['http://127.0.0.1:8888/bot?bot=alice&password=private'];let created=0,closed=0;
  const existing={url:()=>urls[0]};
  const browser:any={pages:async()=>[existing],newPage:async()=>{created++;return {goto:async()=>{throw new Error('failed')},close:async()=>closed++}}};
  const alice={agentId:'a',username:'alice',password:'private'};
  assert.equal((await ensureTabs(browser,'http://127.0.0.1:8888',[alice])).get('a'),existing);
  assert.equal(created,0);
  await assert.rejects(ensureTabs(browser,'http://127.0.0.1:8888',[alice,{...alice,agentId:'b',username:'bob'}]),/failed/);
  assert.equal(closed,1);
});

