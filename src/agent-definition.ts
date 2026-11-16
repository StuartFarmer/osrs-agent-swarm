import type { Message } from '@earendil-works/pi-ai';
import type { Observation,Stamp } from './game.ts';
import type { Store } from './store.ts';
import type { AgentKey,JsonValue,MemoryRevision,Profile } from './types.ts';
export type Domain='position'|'inventory'|'chat'|'nearby'|'interfaces'|'bank'|'shop';
export type AgentView={stamp:Stamp;domains:Partial<Record<Domain,JsonValue>>;derived:Record<string,JsonValue>};
export type ContextInput={
  view:AgentView;memory:{read():MemoryRevision};history:{search(query:string,limit?:number):JsonValue[]};
  objective:string;instructions:string;taskMessages:Message[];
};
export type AgentDefinition={id:string;observe(raw:Readonly<Observation>):AgentView;buildContext(input:ContextInput):Promise<Message[]>};
export function json(value:unknown):JsonValue{return JSON.parse(JSON.stringify(value??null))}
export function domainView(o:Observation,domains:Domain[]):AgentView{
  const r=o.raw;
  const all:Record<Domain,JsonValue>={
    position:json({player:r.player,skills:r.skills}),inventory:json({items:r.inventory,equipment:r.equipment}),
    chat:json(r.gameMessages),nearby:json({players:r.nearbyPlayers,npcs:r.nearbyNpcs,objects:r.nearbyLocs,groundItems:r.groundItems}),
    interfaces:json({dialog:r.dialog,interface:r.interface,trade:r.trade}),
    bank:json({current:r.bank,lastSeen:o.knownBank}),shop:json(r.shop),
  };
  return {stamp:o.stamp,domains:Object.fromEntries(domains.map(d=>[d,all[d]])),derived:{}};
}
export function project(definition:AgentDefinition,observation:Observation):AgentView{
  return structuredClone(definition.observe(structuredClone(observation)));
}
// Operator events contain raw inputs; only these deliberately reduced records reach an agent.
export function historyFor(key:AgentKey,store:Store,query:string,limit=50):JsonValue[]{
  if(!Number.isInteger(limit)||limit<1||limit>50||typeof query!=='string'||query.length>400)throw new Error('invalid history query');
  let after=0;const matches:JsonValue[]=[];
  for(;;){
    const events=store.events(key,after,1000);if(!events.length)break;
    for(const e of events){
      let safe:JsonValue|undefined;
      if(e.type==='memory_updated')safe={type:e.type,time:e.time,data:e.data};
      if(e.type==='action_outcome'){
        const d=e.data as {status:string};
        safe={type:e.type,time:e.time,actionId:e.actionId??'',status:d.status};
      }
      if(safe&&JSON.stringify(safe).toLowerCase().includes(query.toLowerCase())){matches.push(safe);if(matches.length>limit)matches.shift()}
    }
    after=events.at(-1)!.seq;
  }
  return matches;
}
export function contextInput(definition:AgentDefinition,o:Observation,key:AgentKey,store:Store,profile:Profile,taskMessages:Message[]):ContextInput{
  return {view:project(definition,o),memory:{read:()=>store.readMemory(key)},history:{search:(q,n)=>historyFor(key,store,q,n)},
    objective:profile.objective,instructions:profile.instructions,taskMessages:structuredClone(taskMessages)};
}
export function tableau(input:ContextInput,extra:Record<string,JsonValue>={}):Message{
  return {role:'user',content:'<live-state>\n'+JSON.stringify({objective:input.objective,instructions:input.instructions,
    observation:input.view,memory:input.memory.read(),...extra})+'\n</live-state>',timestamp:Date.now()};
}

