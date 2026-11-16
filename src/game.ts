import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { localUrl } from './config.ts';
import type { AgentKey, ActionOutcome, JsonValue } from './types.ts';
export type Stamp = { sessionEpoch:string; observationSeq:number; observedAt:number };
export type ItemRef = { slot:number; id:number };
export type PlayerRef = { index:number; name:string };
export type EntityRef = { id:number; x:number; z:number; index?:number; level?:number };
export type Offer = { id:number; count:number };
type Stamped = { stamp:Stamp };
export type GameAction = Stamped & (
  | {kind:'say';text:string} | {kind:'dm';targetName:string;text:string}
  | {kind:'walk';x:number;z:number} | {kind:'follow'|'trade_request';player:PlayerRef}
  | {kind:'stop_follow'|'trade_decline'|'close_interface'|'bank_open'}
  | {kind:'trade_offer';partner:string;give:Offer[];receive:Offer[];item:ItemRef;count:number}
  | {kind:'trade_accept';partner:string;screen:'offer'|'confirm';give:Offer[];receive:Offer[]}
  | {kind:'drop'|'bank_deposit'|'bank_withdraw'|'shop_buy'|'shop_sell';item:ItemRef;count:number}
  | {kind:'equip'|'unequip'|'eat';item:ItemRef}
  | {kind:'pickup';target:EntityRef}
  | {kind:'interact_npc'|'interact_loc';target:EntityRef;option:number}
  | {kind:'attack'|'shop_open';target:EntityRef}
  | {kind:'choose_dialog';pageId:string;option:number}
  | {kind:'gather';skill:'chop'|'mine'|'fish';target:EntityRef;durationSeconds:number;option:number}
);
export type Entity = { id:number;name:string;x:number;z:number;index?:number;level?:number;optionsWithIndex?:{opIndex:number;text:string}[];[key:string]:unknown };
export type Item = {slot:number;id:number;count:number;name:string;[key:string]:unknown};
export type RawState = {
  tick:number;inGame:boolean;player:{name:string;worldX:number;worldZ:number;level:number;[key:string]:unknown}|null;
  inventory:Item[];equipment:Item[];nearbyNpcs:Entity[];nearbyPlayers:({index:number;name:string;[key:string]:unknown})[];
  nearbyLocs:Entity[];groundItems:Entity[];gameMessages:unknown[];skills:unknown[];
  bank:{isOpen:boolean;items:Item[]};shop:{isOpen:boolean;shopItems:Item[]};
  dialog:{isOpen:boolean;pageId?:string;options:{index?:number;[key:string]:unknown}[]};
  interface:unknown;trade?:{isOpen:boolean;screen:'offer'|'confirm'|null;partner:string|null;myOffer:Offer[];theirOffer:Offer[]};
  [key:string]:unknown;
};
export type Observation = {stamp:Stamp;ageMs:number;clientTick:number;raw:RawState;knownBank:{observedAt:number;items:Item[]}|null};
export type GameClient = {observe():Observation;ready(signal:AbortSignal):Promise<void>;execute(action:GameAction,signal:AbortSignal):Promise<ActionOutcome>;close():Promise<void>};
export type Transport = {
  snapshot():{raw:RawState|null;receivedAt:number;seq:number};
  dispatch(action:GameAction,state:RawState,signal:AbortSignal):Promise<{success:boolean;phase?:string;reason?:string}>;
  close():Promise<void>;
};
const sameOffers=(a:Offer[],b:Offer[])=>{
  const sum=(xs:Offer[])=>{const m=new Map<number,number>();for(const x of xs)m.set(x.id,(m.get(x.id)||0)+x.count);return [...m].sort((a,b)=>a[0]-b[0])};
  return JSON.stringify(sum(a))===JSON.stringify(sum(b));
};
function validate(a:GameAction,s:RawState):void {
  if(!s.player||!s.inGame)throw new Error('not ready');
  if('item' in a){
    const items=a.kind==='bank_withdraw'?s.bank.items:a.kind==='shop_buy'?s.shop.shopItems:a.kind==='unequip'?s.equipment:s.inventory;
    const item=items.find(x=>x.slot===a.item.slot&&x.id===a.item.id);
    if(!item)throw new Error('item reference changed');
    if('count' in a && (!Number.isSafeInteger(a.count)||a.count<1||a.count>item.count))throw new Error('invalid count');
    if(a.kind.startsWith('bank_')&&!s.bank.isOpen)throw new Error('bank closed');
    if(a.kind.startsWith('shop_')&&!s.shop.isOpen)throw new Error('shop closed');
  }
  if('player' in a&&!s.nearbyPlayers.some(x=>x.index===a.player.index&&x.name===a.player.name))throw new Error('player reference changed');
  if('target' in a){
    const list=a.kind==='pickup'?s.groundItems:
      ['attack','shop_open','interact_npc'].includes(a.kind)||(a.kind==='gather'&&a.skill==='fish')?s.nearbyNpcs:s.nearbyLocs;
    const match=list.find(x=>x.id===a.target.id&&
      (a.target.index!==undefined?x.index===a.target.index:x.x===a.target.x&&x.z===a.target.z&&
        (a.kind==='pickup'||x.level===a.target.level)));
    if(!match)throw new Error('target reference changed');
    if('option' in a&&!match.optionsWithIndex?.some(o=>o.opIndex===a.option))throw new Error('unpublished option');
    if(a.kind==='gather'){
      if(!Number.isFinite(a.durationSeconds)||a.durationSeconds<=0||a.durationSeconds>30)throw new Error('invalid activity duration');
      const option=match.optionsWithIndex?.find(o=>o.opIndex===a.option)?.text||'';
      const pattern={chop:/chop/i,mine:/mine/i,fish:/net|bait|lure|harpoon|cage|fish/i}[a.skill];
      if(!pattern.test(option))throw new Error('option is not this gathering skill');
    }
  }
  if(a.kind==='trade_accept'||a.kind==='trade_offer'){
    const t=s.trade;
    if(!t?.isOpen||t.partner!==a.partner||t.screen!==(a.kind==='trade_accept'?a.screen:'offer')||
      !sameOffers(t.myOffer,a.give)||!sameOffers(t.theirOffer,a.receive))throw new Error('trade intent changed');
  }
  if(a.kind==='choose_dialog'&&(!s.dialog.isOpen||s.dialog.pageId!==a.pageId||!s.dialog.options.some(o=>o.index===a.option)))throw new Error('dialog changed');
  if('text' in a&&(typeof a.text!=='string'||a.text.length<1||a.text.length>400))throw new Error('invalid chat length');
  if(a.kind==='dm'&&!/^[a-zA-Z0-9 _-]{1,12}$/.test(a.targetName))throw new Error('invalid recipient');
  if(a.kind==='walk'&&![a.x,a.z].every(n=>Number.isSafeInteger(n)&&n>=0&&n<=16383))throw new Error('invalid coordinates');
}
export function createGame(transport:Transport,freshnessMs=3000):GameClient {
  const epoch=randomUUID();const issued=new Map<number,Stamp>();
  let tail=Promise.resolve();let knownBank:Observation['knownBank']=null;let closed=false;
  function observe():Observation {
    const {raw,receivedAt,seq}=transport.snapshot();
    if(closed||!raw)throw new Error('game offline');
    const stamp={sessionEpoch:epoch,observationSeq:seq,observedAt:receivedAt};
    issued.set(seq,stamp);for(const [n,v] of issued)if(Date.now()-v.observedAt>freshnessMs)issued.delete(n);
    if(raw.bank.isOpen)knownBank={observedAt:receivedAt,items:structuredClone(raw.bank.items)};
    return {stamp,ageMs:Date.now()-receivedAt,clientTick:raw.tick,raw:structuredClone(raw),knownBank:structuredClone(knownBank)};
  }
  return {
    observe,
    async ready(signal){while(true){signal.throwIfAborted();try{const o=observe();if(o.raw.inGame&&o.raw.player&&o.ageMs<=freshnessMs)return}catch{}await delay(100,undefined,{signal})}},
    execute(action,signal){
      const work=tail.then(async():Promise<ActionOutcome>=>{
        let dispatched=false;
        try{
          signal.throwIfAborted();
          const original=issued.get(action.stamp.observationSeq);
          if(!original||action.stamp.sessionEpoch!==epoch||original.observedAt!==action.stamp.observedAt||
            Date.now()-original.observedAt>freshnessMs)throw new Error('stale action reference');
          const o=observe();
          if(o.ageMs>freshnessMs)throw new Error('stale state');
          validate(action,o.raw);signal.throwIfAborted();dispatched=true;
          const r=await transport.dispatch(action,o.raw,signal);
          if(signal.aborted)return {status:'uncertain',message:'Action cancelled after dispatch; inspect state before another action.',evidence:null};
          return {status:r.success?(r.phase==='completion'?'completed':'dispatched'):(r.reason==='timeout'?'uncertain':'failed'),
            message:r.success?'Action sent; inspect fresh state for its effect.':'Action did not confirm success.',evidence:null};
        }catch{
          return {status:dispatched?'uncertain':'failed',message:dispatched?'Outcome unknown; inspect state.':'Action refused: stale, invalid, changed, or cancelled.',evidence:null};
        }
      });
      tail=work.then(()=>{},()=>{});return work;
    },
    async close(){closed=true;await transport.close();await tail},
  };
}
export async function connectGame(key:AgentKey,account:{username:string;password:string},world:{gatewayUrl:string}):Promise<GameClient>{
  localUrl(world.gatewayUrl,['ws:']);
  const sdkPath=new URL('../vendor/rs-sdk/sdk/index.ts',import.meta.url).href;
  const actionsPath=new URL('../vendor/rs-sdk/sdk/actions.ts',import.meta.url).href;
  const contextPath=new URL('../vendor/rs-sdk/sdk/execution-context.ts',import.meta.url).href;
  const [{BotSDK},{BotActions},{executionContext}]=await Promise.all([import(sdkPath),import(actionsPath),import(contextPath)]);
  const sdk=new BotSDK({botUsername:account.username,password:account.password,gatewayUrl:world.gatewayUrl,
    connectionMode:'control',autoLaunchBrowser:false,autoReconnect:false,readyTimeout:0,showChat:true,actionTimeout:30000});
  const bot=new BotActions(sdk);let seq=0;sdk.onStateUpdate(()=>seq++);
  try {await sdk.connect()}catch(e){await sdk.disconnect();throw e}
  return createGame({
    snapshot:()=>({raw:sdk.getState(),receivedAt:sdk.getStateReceivedAt()??0,seq}),
    close:()=>sdk.disconnect(),
    dispatch:(a,s,signal)=>executionContext.run({signal},async()=>{
      const item='item' in a?(a.kind==='bank_withdraw'?s.bank.items:a.kind==='shop_buy'?s.shop.shopItems:a.kind==='unequip'?s.equipment:s.inventory).find(x=>x.slot===a.item.slot):undefined;
      const entity='target' in a?[...s.nearbyNpcs,...s.nearbyLocs,...s.groundItems].find(x=>x.id===a.target.id&&
        (a.target.index!==undefined?x.index===a.target.index:x.x===a.target.x&&x.z===a.target.z)):undefined;
      switch(a.kind){
        case 'say':return sdk.sendSay(a.text);
        case 'dm':return sdk.sendPrivateMessage(a.targetName,a.text);
        case 'walk':return sdk.sendWalk(a.x,a.z);
        case 'follow':return sdk.sendInteractPlayer(a.player.index,3);
        case 'stop_follow':return sdk.sendWalk(s.player!.worldX,s.player!.worldZ);
        case 'trade_request':return sdk.sendTradeRequest(a.player.index);
        case 'trade_offer':return sdk.sendOfferItem(a.item.slot,a.count);
        case 'trade_accept':return sdk.sendAcceptTrade();
        case 'trade_decline':return sdk.sendDeclineTrade();
        case 'drop':return bot.dropItem(item,a.count);
        case 'pickup':return bot.pickupItem(entity);
        case 'interact_npc':return sdk.sendInteractNpc(a.target.index,a.option);
        case 'interact_loc':return sdk.sendInteractLoc(a.target.x,a.target.z,a.target.id,a.option);
        case 'choose_dialog':return sdk.sendClickDialog(a.option);
        case 'close_interface':return bot.closeInterface();
        case 'bank_open':return bot.openBank();
        case 'bank_deposit':return bot.depositItem(item,a.count);
        case 'bank_withdraw':return bot.withdrawItem(item,a.count);
        case 'shop_open':return bot.openShop(entity);
        case 'shop_buy':return bot.buyFromShop(item,a.count);
        case 'shop_sell':return bot.sellToShop(item,a.count);
        case 'equip':return bot.equipItem(item);
        case 'unequip':return bot.unequipItem(item);
        case 'eat':return bot.eatFood(item);
        case 'attack':return bot.attack(entity);
        case 'gather':{
          const bounded=AbortSignal.any([signal,AbortSignal.timeout(a.durationSeconds*1000)]);
          return executionContext.run({signal:bounded},async()=>{
            if(a.skill==='chop')return bot.chopTree(entity);
            if(a.skill==='mine')return bot.mineRock(entity,{timeout:a.durationSeconds*1000});
            return sdk.sendInteractNpc(a.target.index,a.option);
          });
        }
      }
    }),
  });
}

