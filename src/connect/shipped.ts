/**
 * connect/shipped.ts — the connector catalog by name: the services that ship with the
 * package, and the org's own beside them (`<org>/connectors/<name>/`, CONNECTORS.md). A
 * leaf, so the edge reads the catalog without the store or the doors behind it.
 */

/** The services that ship with the package — each `src/connect/<name>/` a connect door.
 *  A name, not a stat: where the package is may be a URL. */
export const SHIPPED = [
  "slack",
  "google",
  "whatsapp",
  "telegram",
  "github",
  "microsoft",
  "mercadopago",
  "token",
  "ai",
];
/** The shipped services with a run.ts — the ones that ingest or deliver, so `liquen start`
 *  runs one process each. `token` grants a bearer and `ai` a model key, and neither runs. */
export const RUNNING = [
  "slack",
  "google",
  "whatsapp",
  "telegram",
  "github",
  "microsoft",
  "mercadopago",
];

/** Every connector the org has: the shipped ones and each folder under
 *  `<org>/connectors/`, read afresh on each call so a connector the org adds is known at
 *  once. */
export function connectorsOf(root: string): Set<string> {
  const names = new Set(SHIPPED);
  try {
    for (const e of Deno.readDirSync(`${root}/connectors`)) {
      if (e.isDirectory) names.add(e.name);
    }
  } catch {
    // no connectors/ folder: the shipped ones alone
  }
  return names;
}
