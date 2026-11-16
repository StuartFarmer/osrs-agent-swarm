import { readFile,mkdir,writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { localUrl } from './config.ts';
import { ownsProcess,spawnOwned,stopOwned,writeJson } from './world.ts';
import type { WorldHandle,OwnedProcess } from './world.ts';
import type { AgentEntry } from './types.ts';
export type Account={agentId:string;username:string;password:string};
type Page={url():string;goto(url:string,options?:unknown):Promise<unknown>;close():Promise<void>;bringToFront():Promise<void>;screenshot(options:unknown):Promise<Uint8Array>;isClosed():boolean};
type Browser={pages():Promise<Page[]>;newPage():Promise<Page>;disconnect():Promise<void>};
export type BrowserHandle={focus(agentId:string):Promise<void>;capture(agentId:string):Promise<Buffer>;connected(agentId:string):Promise<boolean>;close():Promise<void>};
export async function accountsFor(world:WorldHandle,agents:AgentEntry[]):Promise<Account[]>{
  const path=join(world.dir,'accounts.json');
  if(existsSync(path)){
    const accounts=JSON.parse(await readFile(path,'utf8')) as Account[];
    if(accounts.length!==agents.length||accounts.some((a,i)=>a.agentId!==agents[i].id||!/^[a-z0-9]{1,12}$/.test(a.username)))throw new Error('account roster mismatch');
    return accounts;
  }
  const prefix=randomBytes(3).toString('hex');
  const accounts=agents.map((a,i)=>({agentId:a.id,username:'s'+prefix+String(i+1).padStart(2,'0'),password:randomBytes(16).toString('hex')}));
  await writeFile(path,JSON.stringify(accounts,null,2),{flag:'wx',mode:0o600});return accounts;
}
function botName(page:Page,origin:string):string|null{
  try{const u=new URL(page.url());return u.origin===origin&&u.pathname==='/bot'?u.searchParams.get('bot'):null}catch{return null}
}
export async function ensureTabs(browser:Browser,origin:string,accounts:Account[]):Promise<Map<string,Page>>{
  localUrl(origin,['http:']);const pages=await browser.pages(),result=new Map<string,Page>(),created:Page[]=[];
  try{
    for(const a of accounts){
      const matches=pages.filter(p=>botName(p,origin)===a.username);
      if(matches.length>1)throw new Error('duplicate character tabs: '+a.agentId);
      let page=matches[0];
      if(!page){
        page=await browser.newPage();created.push(page);
        const url=new URL('/bot',origin);url.searchParams.set('bot',a.username);url.searchParams.set('password',a.password);
        await page.goto(url.href,{waitUntil:'domcontentloaded',timeout:30000});
      }
      result.set(a.agentId,page);
    }
    return result;
  }catch(e){await Promise.allSettled(created.map(p=>p.close()));throw e}
}
async function connect(endpoint:string):Promise<Browser>{
  const packageName='puppeteer';
  const {default:puppeteer}=await import(packageName);
  return puppeteer.connect({browserWSEndpoint:endpoint,defaultViewport:null});
}
export async function attachBrowser(world:WorldHandle,accounts:Account[]):Promise<BrowserHandle>{
  const metadata=JSON.parse(await readFile(join(world.dir,'browser.json'),'utf8')) as {process:OwnedProcess;endpoint:string};
  if(!await ownsProcess(metadata.process))throw new Error('rendered browser is not running');
  const browser=await connect(metadata.endpoint);
  async function page(id:string):Promise<Page>{
    const a=accounts.find(a=>a.agentId===id);if(!a)throw new Error('unknown agent');
    const matches=(await browser.pages()).filter(p=>botName(p,world.gameUrl)===a.username);
    if(matches.length!==1)throw new Error('character tab missing or duplicated');
    return matches[0];
  }
  return {focus:async id=>(await page(id)).bringToFront(),
    capture:async id=>Buffer.from(await (await page(id)).screenshot({type:'png'})),
    connected:async id=>{try{return !(await page(id)).isClosed()}catch{return false}},
    close:()=>browser.disconnect()};
}
export async function startBrowser(world:WorldHandle,accounts:Account[]):Promise<BrowserHandle>{
  const metadataPath=join(world.dir,'browser.json');
  let metadata: {process:OwnedProcess;endpoint:string}|undefined;
  if(existsSync(metadataPath)){
    const previous=JSON.parse(await readFile(metadataPath,'utf8'));
    if(await ownsProcess(previous.process))metadata=previous;
  }
  let owned:OwnedProcess|undefined;
  try{
    if(!metadata){
      const packageName='puppeteer';const {default:puppeteer}=await import(packageName);
      const profile=join(world.dir,'browser-profile');await mkdir(profile,{recursive:true,mode:0o700});
      // DevToolsActivePort may be stale after a browser exit; use a fresh profile for a new process.
      const sessionProfile=join(profile,randomBytes(8).toString('hex'));await mkdir(sessionProfile);
      const executable=process.env.CHROMIUM_PATH||puppeteer.executablePath();
      owned=await spawnOwned(executable,['--user-data-dir='+sessionProfile,'--remote-debugging-port=0','--remote-debugging-address=127.0.0.1','--no-first-run','about:blank'],
        world.dir,join(world.dir,'browser.log'));
      let endpoint='';
      for(let i=0;i<100;i++){
        try{const [port,path]= (await readFile(join(sessionProfile,'DevToolsActivePort'),'utf8')).trim().split('\n');
          if(!/^\d+$/.test(port)||!path.startsWith('/devtools/browser/'))throw new Error('invalid browser endpoint');
          endpoint='ws://127.0.0.1:'+port+path;break}catch{await delay(100)}
      }
      if(!endpoint)throw new Error('browser startup timeout');
      metadata={process:owned,endpoint};await writeJson(metadataPath,metadata);
    }
    const browser=await connect(metadata.endpoint);
    try{await ensureTabs(browser,world.gameUrl,accounts)}finally{await browser.disconnect()}
    return attachBrowser(world,accounts);
  }catch(e){if(owned&&await ownsProcess(owned))await stopOwned(owned);throw e}
}

