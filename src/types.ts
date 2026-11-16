export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type AgentKey = { runId: string; worldId: string; agentId: string };
export type Memory = {
  plan: string[];
  beliefs: string[];
  relationships: Record<string, string>;
  nextAction: string;
};
export type MemoryRevision = { revision: number; value: Memory };
export type ModelConfig = {
  provider: string;
  modelId: string;
  baseUrl: string;
  apiKeyEnv: string;
  contextWindow: number;
  costLimitUsd: number;
  zeroCost: boolean;
  rates: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
};
export type Limits = {
  requests: number;
  tools: number;
  taskSeconds: number;
  outputTokens: number;
  freshnessMs: number;
  contextBytes: number;
  memoryBytes: number;
  artifactBytes: number;
};
export type AgentEntry = {
  id: string;
  definition: "merchant" | "gatherer" | "runebench";
  profilePath: string;
  instructionsPath: string;
};
export type Experiment = {
  world: {
    id: string;
    gameUrl: string;
    gatewayUrl: string;
    tickMs: number;
    xpRate: number;
  };
  durationSeconds: number;
  preparationSeconds: number;
  concurrency: number;
  healthyDelayMs: number;
  failureDelayMs: number;
  limits: Limits;
  model: ModelConfig | null;
  agents: AgentEntry[];
};
export type Profile = {
  role: string;
  objective: string;
  instructions: string;
  hash: string;
};
export type ActionOutcome = {
  status: "completed" | "dispatched" | "failed" | "uncertain";
  message: string;
  evidence: JsonValue;
};
