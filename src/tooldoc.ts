/**
 * tooldoc.ts — a builtin tool's words (DESIGN §9): what the model reads about a tool lives
 * in `system/instructions/tools/<name>.md`, editable like any instruction; the code holds
 * the schema the handler reads — names, types, enums, what is required — and no words.
 *
 * The file has no frontmatter, so the docs index never lists it; the harness reads it by
 * name each turn. Its last block, after a blank line, is one item per parameter:
 *
 *   - name: what it is
 *     a wrapped line continues the item above it
 *     - field: an object parameter's own field, indented under it
 *
 * Everything before that block is the tool's description: a wrapped line joins the one
 * above it with a space, a line opening `- ` starts a line of its own, and a blank line
 * keeps a paragraph break. `{{name}}` stands for a number the code holds — a default, a
 * cap — filled from the tool's `vars`.
 *
 * The file and the schema must agree: every top-level parameter has its item, every item
 * names a parameter, every placeholder a var. Any mismatch is an error naming the file,
 * checked at boot (`checkToolDocs`) and again on each turn's read.
 */

import type Anthropic from "@anthropic-ai/sdk";

export type ToolVars = Record<string, string | number>;

/** A builtin tool before its words: the schema, and the values its placeholders take. */
export interface ToolShape {
  spec: Anthropic.Tool;
  vars?: ToolVars;
}

/** A tool's doc by name: the text, or null when the file is gone. */
export type ToolDocReader = (name: string) => Promise<string | null>;

/** Where a tool's words live, relative to the system scope. */
export const toolDocName = (tool: string) => `instructions/tools/${tool}`;

const fileOf = (tool: string) => `system/${toolDocName(tool)}.md`;

interface Item {
  text: string;
  fields: Map<string, Item>;
}

const ITEM = /^( *)- ([A-Za-z_]\w*):(?: (.*))?$/;

/** Prose lines → text: soft-wrapped lines join with a space, a `- ` line keeps its own. */
function unwrap(lines: string[]): string {
  let out = "";
  for (const raw of lines) {
    const line = raw.trim();
    if (!out) out = line;
    else out += (line.startsWith("- ") ? "\n" : " ") + line;
  }
  return out;
}

/** The parameter block → items by name, two levels deep. */
function itemsOf(block: string[], file: string): Map<string, Item> {
  const top = new Map<string, Item>();
  let current: Item | undefined;
  let parent: Item | undefined;
  for (const line of block) {
    const m = ITEM.exec(line);
    if (m && (m[1].length === 0 || m[1].length === 2)) {
      const item: Item = { text: m[3]?.trim() ?? "", fields: new Map() };
      const into = m[1].length === 0 ? top : parent?.fields;
      if (!into) throw new Error(`${file}: \`${m[2]}\` is indented under no parameter`);
      if (into.has(m[2])) throw new Error(`${file}: \`${m[2]}\` has two items`);
      into.set(m[2], item);
      if (m[1].length === 0) parent = item;
      current = item;
    } else if (current && /^\s+\S/.test(line)) {
      current.text = current.text ? `${current.text} ${line.trim()}` : line.trim();
    } else {
      throw new Error(`${file}: \`${line.trim()}\` is not a parameter item (\`- name: …\`)`);
    }
  }
  return top;
}

type Props = Record<string, Record<string, unknown>>;

const propsOf = (schema: unknown): Props =>
  ((schema as { properties?: Props } | undefined)?.properties) ?? {};

/** One tool's shape + its doc's text → the tool as the model reads it. Throws on any
 *  disagreement between the two, naming the file. */
export function worded(shape: ToolShape, text: string): Anthropic.Tool {
  const { name } = shape.spec;
  const file = fileOf(name);
  const fill = (s: string) =>
    s.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
      const v = shape.vars?.[key];
      if (v === undefined) throw new Error(`${file}: no value for {{${key}}}`);
      return String(v);
    });
  const props = propsOf(shape.spec.input_schema);
  const blocks = text.replace(/\r\n/g, "\n").trim().split(/\n[ \t]*\n/).map((b) => b.split("\n"));
  const params = Object.keys(props).length > 0 ? blocks.pop()! : [];
  if (blocks.length === 0) throw new Error(`${file}: no description before the parameters`);
  const items = itemsOf(params, file);
  const describe = (schema: Props, given: Map<string, Item>, whole: boolean): Props => {
    for (const key of given.keys()) {
      if (!(key in schema)) throw new Error(`${file}: \`${key}\` is not a parameter of ${name}`);
    }
    const out: Props = {};
    for (const [key, prop] of Object.entries(schema)) {
      const item = given.get(key);
      if (!item) {
        if (whole) throw new Error(`${file}: no item for \`${key}\``);
        out[key] = prop;
        continue;
      }
      if (item.fields.size > 0 && !prop.properties) {
        throw new Error(`${file}: \`${key}\` has no fields to describe`);
      }
      out[key] = {
        ...prop,
        ...(prop.properties
          ? { properties: describe(prop.properties as Props, item.fields, false) }
          : {}),
        description: fill(item.text),
      };
    }
    return out;
  };
  return {
    ...shape.spec,
    description: blocks.map(unwrap).map(fill).join("\n\n"),
    input_schema: { ...shape.spec.input_schema, properties: describe(props, items, true) },
  };
}

/** Each shape worded from its doc; a missing doc is an error naming the file. */
export async function wordedAll(
  shapes: ToolShape[],
  read: ToolDocReader,
): Promise<Anthropic.Tool[]> {
  return await Promise.all(shapes.map(async (shape) => {
    const text = await read(toolDocName(shape.spec.name));
    if (text === null) throw new Error(`${fileOf(shape.spec.name)} is missing`);
    return worded(shape, text);
  }));
}

/** Boot's look at every builtin tool's doc: the first that disagrees with its schema
 *  stops the start, so a broken file is named before any turn needs it. */
export async function checkToolDocs(shapes: ToolShape[], read: ToolDocReader): Promise<void> {
  await wordedAll(shapes, read);
}
