import { assertEquals } from "@std/assert";
import { docTools } from "./docs.ts";
import type { DocCalls } from "../store/pg/docs.ts";

Deno.test("the docs tools are the three calls: each forwards its arguments and answers the call's line", async () => {
  const made: string[] = [];
  const calls: DocCalls = {
    read: (handle, offset, limit, maxBytes) => {
      made.push(`read ${handle} ${offset} ${limit} ${maxBytes}`);
      return Promise.resolve("the text");
    },
    write: (handle, content) => {
      made.push(`write ${handle} ${content}`);
      return Promise.resolve(`wrote ${content.length} bytes to ${handle}`);
    },
    edit: (handle, spec) => {
      made.push(`edit ${handle} ${spec}`);
      return Promise.resolve(`applied 1 edit(s) to ${handle}`);
    },
  };
  const tools = docTools(calls);
  assertEquals(Object.keys(tools), ["read", "write", "edit"]);
  assertEquals(tools.read.spec.input_schema.required, ["handle"]);
  assertEquals(tools.write.spec.input_schema.required, ["handle", "content"]);
  assertEquals(tools.edit.spec.input_schema.required, ["handle", "spec"]);
  const signal = new AbortController().signal;
  assertEquals(
    await tools.read.execute({ handle: "agent/x", offset: 3, limit: 2 }, signal),
    "the text",
  );
  assertEquals(
    await tools.write.execute({ handle: "agent/x", content: "hi" }, signal),
    "wrote 2 bytes to agent/x",
  );
  assertEquals(
    await tools.edit.execute({ handle: "agent/x", spec: "s" }, signal),
    "applied 1 edit(s) to agent/x",
  );
  assertEquals(made, ["read agent/x 3 2 undefined", "write agent/x hi", "edit agent/x s"]);
});
