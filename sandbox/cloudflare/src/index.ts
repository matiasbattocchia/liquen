/**
 * The Cloudflare exec plane's gateway (DESIGN §9): the Sandbox SDK's bridge, one sandbox
 * per agent, driven by main over HTTPS with the bearer token `SANDBOX_API_KEY`.
 *
 * A sandbox is reachable only through the Durable Object binding this Worker holds, so the
 * bridge's routes are the whole surface main sees: exec streamed as SSE, a file's bytes,
 * destroy. The sandbox id is main's choice — the agent id, base32-lowercased — and the
 * container behind it starts on the first call.
 */

import { bridge } from "@cloudflare/sandbox/bridge";

export { Sandbox } from "@cloudflare/sandbox";
export { WarmPool } from "@cloudflare/sandbox/bridge";

export default bridge({
  fetch: () => Promise.resolve(new Response("not found", { status: 404 })),
});
