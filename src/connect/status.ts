/**
 * connect/status.ts — connection management, read side: what the machinery holds (§4).
 *
 *   deno task status             # agents · connections · memberships · vault (REDACTED)
 *
 * The setup flows (`oauth:slack`, pairing, future `mu connect <service>`) WRITE the map;
 * this prints it — the first thing a live smoke checks ("did the grant land?"). Secrets
 * never print: the vault lists keys, owners, and the FIELD NAMES of each value blob,
 * never values. Env: none.
 */

import { DatabaseSync } from "node:sqlite";
import { openLog } from "../store/log.ts";

if (import.meta.main) {
  const dir = "./data";
  const log = await openLog(`${dir}/log`);
  const db = new DatabaseSync(`${dir}/log/log.db`);
  const rows = (sql: string) => db.prepare(sql).all() as Record<string, unknown>[];

  console.log("agents (the registry — folders + config.jsonc declare, table mirrors):");
  for (const a of log.agents()) {
    const opts = (["provider", "model", "effort", "email", "phone"] as const)
      .filter((k) => a[k])
      .map((k) => `${k}=${a[k]}`)
      .join("  ");
    console.log(`  ${a.agentId}  home=${a.home}${opts ? "  " + opts : ""}`);
  }

  console.log("\nconnections (owned=private · org-credentialed=shared · stub=gate-only, §6):");
  for (const c of rows("SELECT * FROM connections ORDER BY service, address")) {
    const owner = c.agent_id ? `owner=${c.agent_id}` : c.credential_key ? "shared" : "stub";
    const cred = c.credential_key ? `  cred=${c.credential_key}` : "";
    const extra = c.extra ? `  extra=${c.extra}` : "";
    const dead = c.deleted_at ? `  DELETED ${c.deleted_at}` : "";
    console.log(`  ${c.service}:${c.address}  ${owner}${cred}${extra}${dead}`);
  }

  console.log("\nmemberships (who is enrolled where):");
  for (
    const m of rows(
      "SELECT * FROM memberships ORDER BY service, connection_address, conversation_address",
    )
  ) {
    console.log(
      `  ${m.service}:${m.connection_address} ${m.conversation_address}  ∋ ${m.agent_id}`,
    );
  }

  // the vault shares log.db (§4) — list keys and value FIELD NAMES only, never secrets
  try {
    console.log("\nvault (keys and value field names only — secrets never print):");
    for (
      const t of rows("SELECT key, value, agent_id, updated_at FROM credentials ORDER BY key")
    ) {
      const fields = Object.keys(JSON.parse(String(t.value))).join(",");
      const owner = t.agent_id ? `owner=${t.agent_id}` : "org";
      console.log(`  ${t.key}  ${owner}  fields=${fields}  (${t.updated_at})`);
    }
  } catch {
    console.log("\nvault: (none)");
  }

  db.close();
  await log.close();
}
