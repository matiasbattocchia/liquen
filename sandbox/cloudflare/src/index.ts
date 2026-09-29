/**
 * The Cloudflare exec plane's gateway (DESIGN §9): the Sandbox SDK's bridge, one sandbox
 * per agent, driven by main over HTTPS with the bearer token `SANDBOX_API_KEY`.
 *
 * A sandbox is reachable only through the Durable Object binding this Worker holds, so the
 * bridge's routes are the whole surface main sees: exec streamed as SSE, a file's bytes,
 * destroy. The sandbox id is main's choice — the agent id, base32-lowercased — and the
 * container behind it starts on the first call.
 *
 * A call may carry `x-sleep-after` (`10m`, `1h`: the org's `system.sandboxSleepMinutes`),
 * how long the sandbox lives after its last request: main stops it sooner by its own clock,
 * and this is the limit that holds when main is quiet. Each container the pool starts for a
 * sandbox id is a Durable Object of its own that begins at the SDK's default, so the value
 * rides every call and is set on whichever container answered it, once the bridge has
 * answered — past its authentication.
 */

import { bridge } from "@cloudflare/sandbox/bridge";
import { Sandbox } from "@cloudflare/sandbox";

export { Sandbox };
export { WarmPool } from "@cloudflare/sandbox/bridge";

interface Env {
  Sandbox: DurableObjectNamespace<Sandbox>;
  WarmPool: DurableObjectNamespace;
}

/** The bridge's pool: which container a sandbox id is on now. */
interface Pool {
  lookupContainer(sandboxId: string): Promise<string | null>;
}

const SANDBOX_PATH = /^\/v1\/sandbox\/([a-z2-7]{1,128})\//;
const SLEEP_AFTER = /^\d+[smh]$/;

const gateway = bridge({
  fetch: () => Promise.resolve(new Response("not found", { status: 404 })),
});

/** The container's own stub, named as the bridge names it: `getSandbox`'s wrapper forwards
 *  only the calls it knows, and `setSleepAfter` is not one of them. */
async function sleepAfter(env: Env, sandboxId: string, value: string): Promise<void> {
  const pool = env.WarmPool.get(env.WarmPool.idFromName("global-pool")) as unknown as Pool;
  const container = await pool.lookupContainer(sandboxId);
  if (container) await env.Sandbox.get(env.Sandbox.idFromName(container)).setSleepAfter(value);
}

export default {
  ...gateway,
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const response = await gateway.fetch!(request as never, env as never, ctx);
    const id = SANDBOX_PATH.exec(new URL(request.url).pathname)?.[1];
    const value = request.headers.get("x-sleep-after");
    if (id && value && SLEEP_AFTER.test(value) && response.ok) {
      ctx.waitUntil(sleepAfter(env, id, value));
    }
    return response;
  },
};
