# What is open

The items still under discussion, grounded against main at `2884d04` (2026-11-06). Each says
what holds, shows it, and ends on the options and the one recommended. What is decided lives
in `CHANGES.md`, what is parked in `DESIGN.md` §10.

## Infrastructure

- [ ] **The proxy names no agent on a blind tunnel, nor on an org-wide grant.** For a host a
  grant fronts, the proxy learns the agent from the placeholder it swaps: an agent's own
  grant names it, an org grant names nobody. Any other host it only pipes, and logs
  `CONNECT host` with no one behind it. An agent's own grant works today:
  `liquen connect token parallel --env PARALLEL_API_KEY --hosts api.parallel.ai --agent
  sonar` gives sonar a placeholder of its own, and its egress rows read `agent_id=sonar`.
  The placeholder is what names the agent: the proxy maps it to its grant, and the grant to
  its owner (`proxy.ts:155`). An org grant mints one placeholder that every shell shares
  (`issue` in `grants.ts`), so it names nobody. Two agents may each hold a grant for the
  same host; an org grant on the same variable outranks both, so it goes first.
  *Example:* `[proxy] - CONNECT pypi.org:443 → 200` does not say who installed what. On
  `new`, all 98 egress rows name no agent, the 21 swapped ones included, since
  `token:parallel` is the org's.
  **Options:** (a) the agent rides in the proxy URL, `http://<agent>:<nonce>@127.0.0.1:port`,
  which curl, pip, git, npm, Go and node send on every request and tunnel; (b) a port per
  agent; (c) leave tunnels blind, and give an agent its own grant where a key's use must
  be traced; (d) an org grant mints a placeholder per agent, so every swapped request names
  one, while tunnels stay blind. **Recommended:** (a): the agent comes from the connection,
  whatever the host.
