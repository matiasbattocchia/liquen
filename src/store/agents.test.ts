import { agentsSuite } from "./suite/agents.ts";
import { sqlite } from "./suite/mod.ts";

agentsSuite(sqlite);
