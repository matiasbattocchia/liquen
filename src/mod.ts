/**
 * The harness core: the step (mu), the turn (nu), the consumer (xi), and the process
 * (main) that holds the subscriptions. The store and exec ports are the package boundary.
 */

export type * from "./types.ts";
export { mu } from "./mu.ts";
export type { CallMeta, Emission, ModelTransport, StepInput, StepResult } from "./mu.ts";
export { nu } from "./nu.ts";
export type { TurnConfig, TurnInput, TurnOutput } from "./nu.ts";
export { decide, gateOf, xi } from "./xi.ts";
export type {
  AgentConfig,
  Decision,
  ExecOutcome,
  ExecTool,
  Gate,
  Target,
  Wake,
  XiPorts,
} from "./xi.ts";
export { start } from "./main.ts";
export type { Main, MainConfig } from "./main.ts";
export { anthropicClient, anthropicTransport, metered } from "./transport.ts";
export { init } from "./init.ts";
