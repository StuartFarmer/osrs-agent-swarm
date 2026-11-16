import { domainView,tableau } from '../src/agent-definition.ts';
import type { AgentDefinition } from '../src/agent-definition.ts';
export const merchant:AgentDefinition={
  id:'merchant',
  observe(o){
    const view=domainView(o,['position','inventory','chat','nearby','interfaces','bank','shop']);
    view.derived.liquidCoins=o.raw.inventory.filter(i=>i.id===995).reduce((sum,i)=>sum+i.count,0);
    return view;
  },
  async buildContext(input){
    const outcomes=input.history.search('action_outcome',10);
    return [tableau(input,{recentOutcomes:outcomes}),...input.taskMessages];
  },
};

