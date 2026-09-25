/**
 * exec/docs.ts — the docs tools (DESIGN §9): read · write · edit, where the docs live in
 * the table.
 *
 * The database substrate's primitive, by handle: the binaries' contracts (`bin/afs.ts`)
 * as three tool calls, each answering the line the binary prints. The model writes no
 * SQL; every call is a function of the store the harness invokes under the agent role,
 * and what the agent may reach is the table's policy (`store/pg/schema.ts`).
 */

import type { DocCalls } from "../store/pg/docs.ts";
import type { ExecTool } from "../xi.ts";
import type { Json } from "../types.ts";
import { MAX_BYTES, MAX_LINES } from "./truncate.ts";

const HANDLE = {
  type: "string",
  description: "the doc's handle as the index prints it: scope/name — system, organization, " +
    "agent (your own) or conversation (this one's), then the doc's name",
};

/** The three calls over an agent's reach. */
export function docTools(calls: DocCalls): Record<string, ExecTool> {
  return {
    read: {
      spec: {
        name: "read",
        description: "Read a doc by its handle, frontmatter included, from line `offset` " +
          `(1-indexed), \`limit\` lines at most; head-truncated to ${MAX_LINES} lines / ${
            MAX_BYTES / 1024
          }KB (override with limit/max_bytes), the footer naming the line to continue from.`,
        input_schema: {
          type: "object",
          properties: {
            handle: HANDLE,
            offset: { type: "number", description: "first line to show (optional; default 1)" },
            limit: { type: "number", description: "lines to show (optional)" },
            max_bytes: {
              type: "number",
              description: `byte cap (optional; default ${MAX_BYTES})`,
            },
          },
          required: ["handle"],
        },
      },
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
      spec: {
        name: "write",
        description: "Write a doc whole by its handle — the frontmatter (kind, description, " +
          "load) and the body, as a file holds them; creates it or replaces it. Your own " +
          "scope (agent/…) and this conversation's (conversation/…) are yours to write.",
        input_schema: {
          type: "object",
          properties: {
            handle: HANDLE,
            content: { type: "string", description: "the whole text, frontmatter included" },
          },
          required: ["handle", "content"],
        },
      },
      execute(input: Json) {
        const { handle, content } = input as { handle: string; content: string };
        return calls.write(handle, content);
      },
    },
    edit: {
      spec: {
        name: "edit",
        description: "Edit a doc in place by its handle with conflict-marker blocks " +
          "(<<<<<<< old ======= new >>>>>>>): every old text must match the doc once, " +
          "exactly or ignoring trailing whitespace, and blocks must not overlap.",
        input_schema: {
          type: "object",
          properties: {
            handle: HANDLE,
            spec: { type: "string", description: "one or more conflict-marker blocks" },
          },
          required: ["handle", "spec"],
        },
      },
      execute(input: Json) {
        const { handle, spec } = input as { handle: string; spec: string };
        return calls.edit(handle, spec);
      },
    },
  };
}
