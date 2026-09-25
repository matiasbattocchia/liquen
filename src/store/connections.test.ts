import { connectionsSuite } from "./suite/connections.ts";
import { sqlite } from "./suite/mod.ts";

connectionsSuite(sqlite);
