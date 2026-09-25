/**
 * connect/status.ts — connection management, read side: what the machinery holds (§4).
 *
 *   deno task status             # agents · connections · memberships · wakes · vault (REDACTED)
 *
 * The setup flows (`liquen connect <service>`: pastes, pairing, a sign-in) WRITE the map;
 * this prints it — the first thing a live smoke checks ("did the grant land?"). Every line
 * is read through the store's ports, so it prints the same wherever the catalog put the
 * store. Secrets never print: the vault lists keys, owners, and the FIELD NAMES of each
 * value blob, never values. Env: the store's password when the catalog names Postgres.
 */

import { openStore } from "../store/mod.ts";
import { findRoot, orgFlag } from "../config.ts";
import { entry } from "../entry.ts";

if (import.meta.main) {
  await entry(async () => {
    const root = findRoot(orgFlag());
    const store = await openStore(root);
    const log = await store.log();
    const creds = await store.vault();

    console.log("agents (the registry — folders + config.jsonc declare, table mirrors):");
    for (const a of await log.agents()) {
      const opts = (["provider", "model", "effort", "email", "phone"] as const)
        .filter((k) => a[k])
        .map((k) => `${k}=${a[k]}`)
        .join("  ");
      console.log(`  ${a.agentId}  mind=${a.mind}${opts ? "  " + opts : ""}`);
    }

    console.log(
      "\nconnections (the live map: owned=private · org-credentialed=shared · stub=gate-only, §6):",
    );
    for (const c of await log.connections()) {
      const owner = c.agentId ? `owner=${c.agentId}` : c.credentialKey ? "shared" : "stub";
      const cred = c.credentialKey ? `  cred=${c.credentialKey}` : "";
      const extra = c.extra ? `  extra=${JSON.stringify(c.extra)}` : "";
      console.log(`  ${c.service}:${c.address}  ${owner}${cred}${extra}`);
    }

    console.log("\nmemberships (who is enrolled where — a stamp is a LEAVE):");
    for (const m of await log.memberships()) {
      const left = m.deletedAt ? `  LEFT ${m.deletedAt}` : "";
      console.log(
        `  ${m.service}:${m.connection} ${m.conversation}  ∋ ${m.agentId}/${m.sessionId}${left}`,
      );
    }

    // armed wakes (§10): the one non-log fact about the future, so the only way to read it
    // is the table. A handle means the org armed it from `liquen schedule`; the rest the
    // agent chose for itself, and a cron says the wake comes back.
    console.log("\narmed wakes (the future — handle = the org's, §10):");
    for (const t of await log.armed()) {
      const who = `${t.agentId}/${t.sessionId}`;
      const repeats = t.cron ? `  repeats=${t.cron}` : "";
      const handle = t.name ? `  ${t.name}` : "";
      console.log(`  ${t.fireAt}  ${who}${handle}${repeats}  id=${t.id}`);
      console.log(`    ${t.note}`);
    }

    // the vault shares the store (§4) — list keys and value FIELD NAMES only, never secrets
    console.log("\nvault (keys and value field names only — secrets never print):");
    for (const r of await creds.list("")) {
      const fields = Object.keys(r.value).join(",");
      const owner = r.agentId ? `owner=${r.agentId}` : "org";
      console.log(`  ${r.key}  ${owner}  fields=${fields}`);
    }

    await creds.close();
    await log.close();
  });
}
