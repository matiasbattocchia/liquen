/**
 * artifact.ts — what an artifact's server imports (`@liquen/liquen/artifact`, DESIGN §9):
 * `serve`, which answers every request of the box its files did not.
 *
 * Under liquen the server listens on the socket main speaks to, named in its environment,
 * and each request carries who opened the box: the visitor's phone, which main alone sets.
 * The path is the one under the box, `/api/buscar` for the page's `fetch("api/buscar")`.
 *
 * Run by hand (`deno run -A server.ts`), it serves the folder's `public/` and the handler at
 * http://127.0.0.1:8000 (`PORT` for another), the way the box does, each request from a
 * visitor with no phone, so an app is tried before it is published.
 *
 * Nothing imported: a server resolves this module through the import map liquen hands it,
 * and nothing else of the package.
 */

/** Who opened the box. */
export interface Visitor {
  /** Their WhatsApp number, digits alone; empty when the server runs by hand. */
  phone: string;
}

export type Handler = (req: Request, visitor: Visitor) => Response | Promise<Response>;

/** The variable liquen names the socket in. */
const SOCKET = "LIQUEN_ARTIFACT_SOCKET";
/** The header main names the visitor in. */
const VISITOR = "liquen-visitor";

const MIME: Record<string, string> = {
  html: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  json: "application/json",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  webp: "image/webp",
  woff2: "font/woff2",
  wasm: "application/wasm",
};

/** Answer the box's requests with `handler`. */
export function serve(handler: Handler): Deno.HttpServer {
  const path = Deno.env.get(SOCKET);
  if (path) {
    return Deno.serve(
      { path, onListen: () => console.log("listening") },
      (req) => handler(req, { phone: req.headers.get(VISITOR) ?? "" }),
    );
  }
  const root = new URL("./public/", Deno.mainModule);
  const port = Number(Deno.env.get("PORT") ?? 8000);
  return Deno.serve({ hostname: "127.0.0.1", port }, async (req) => {
    const { pathname } = new URL(req.url);
    if (req.method === "GET" || req.method === "HEAD") {
      const file = new URL(`.${pathname.endsWith("/") ? `${pathname}index.html` : pathname}`, root);
      if (file.href.startsWith(root.href)) {
        try {
          const bytes = await Deno.readFile(file);
          const ext = file.pathname.slice(file.pathname.lastIndexOf(".") + 1);
          return new Response(bytes, {
            headers: { "content-type": MIME[ext] ?? "application/octet-stream" },
          });
        } catch { /* not a file: the handler's */ }
      }
    }
    return handler(req, { phone: "" });
  });
}
