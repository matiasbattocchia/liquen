/**
 * exec/docs.ts — the docs tools (DESIGN §9): read · write · edit, where the docs live in
 * the table.
 *
 * The database substrate's primitive, by handle: the binaries' contracts (`bin/afs.ts`)
 * as three tool calls, each answering the line the binary prints. The model writes no
 * SQL; every call is a function of the store the harness invokes under the agent role,
 * and what the agent may reach is the table's policy (`store/pg/schema.ts`). Their words
 * are `system/tools/{read,write,edit}.md` (tooldoc.ts).
 */

import type { DocCalls } from "../store/pg/docs.ts";
import type { ExecTool } from "../xi.ts";
import type { Json } from "../types.ts";
import type { ToolShape } from "../tooldoc.ts";
import { MAX_BYTES, MAX_LINES } from "./truncate.ts";

/** The three tools' schemas and the numbers their docs name. */
export const DOC_TOOLS: Record<"read" | "write" | "edit", ToolShape> = {
  read: {
    spec: {
      name: "read",
      input_schema: {
        type: "object",
        properties: {
          handle: { type: "string" },
          offset: { type: "number" },
          limit: { type: "number" },
          max_bytes: { type: "number" },
        },
        required: ["handle"],
      },
    },
    vars: { max_lines: MAX_LINES, max_kb: MAX_BYTES / 1024, max_bytes: MAX_BYTES },
  },
  write: {
    spec: {
      name: "write",
      input_schema: {
        type: "object",
        properties: { handle: { type: "string" }, content: { type: "string" } },
        required: ["handle", "content"],
      },
    },
  },
  edit: {
    spec: {
      name: "edit",
      input_schema: {
        type: "object",
        properties: { handle: { type: "string" }, spec: { type: "string" } },
        required: ["handle", "spec"],
      },
    },
  },
};

/** The three calls over an agent's reach. */
export function docTools(calls: DocCalls): Record<string, ExecTool> {
  return {
    read: {
      ...DOC_TOOLS.read,
      execute(input: Json) {
        const { handle, offset, limit, max_bytes } = input as {
          handle: string;
          offset?: number;
          limit?: number;
          max_bytes?: number;
        };
        return calls.read(handle, offset, limit, max_bytes);
      },
    },
    write: {
      ...DOC_TOOLS.write,
      execute(input: Json) {
        const { handle, content } = input as { handle: string; content: string };
        return calls.write(handle, content);
      },
    },
    edit: {
      ...DOC_TOOLS.edit,
      execute(input: Json) {
        const { handle, spec } = input as { handle: string; spec: string };
        return calls.edit(handle, spec);
      },
    },
  };
}
