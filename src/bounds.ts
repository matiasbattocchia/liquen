/**
 * bounds.ts — what a tool's numbers and lists may be (DESIGN §9).
 *
 * A count a parameter takes declares its `default`, `minimum` and `maximum` in the tool's
 * schema, and a list its `maxItems`, each from a constant the code holds. The schema is the
 * one source: the model reads it there, tooldoc says it at the end of the parameter's line
 * (`boundsSaid`), and `bounded` holds every call to it before the call is gated, the
 * model's and a script's alike, so no handler keeps a default or a range of its own.
 */

type Prop = Record<string, unknown>;

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** The range a schema gives, in words, or undefined when it gives none. */
function rangeOf(prop: Prop): string | undefined {
  const { minimum: lo, maximum: hi, maxItems } = prop;
  if (isNum(lo) && isNum(hi)) return `${lo}–${hi}`;
  if (isNum(lo)) return `${lo} or more`;
  if (isNum(hi)) return `up to ${hi}`;
  if (isNum(maxItems)) return `up to ${maxItems}`;
}

/** Whether a parameter's schema bounds it: a default, a range, a length. */
export const isBounded = (prop: Prop): boolean =>
  prop.default !== undefined || rangeOf(prop) !== undefined;

/** What a bounded parameter's schema says, as its line ends: `optional; default 5; 1–20`. */
export function boundsSaid(prop: Prop, required: boolean): string {
  return [
    required ? undefined : "optional",
    prop.default === undefined ? undefined : `default ${prop.default}`,
    rangeOf(prop),
  ].filter((s) => s !== undefined).join("; ");
}

/** A call's input held to its schema: each absent parameter given its default, and a
 *  count that is no number of its kind or falls out of its range, or a list longer than
 *  its length, refused with what it must be. An object's fields and a list's items are
 *  held the same way. */
export function bounded(
  schema: unknown,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const props = isObject(schema) && isObject(schema.properties) ? schema.properties : {};
  return held(props as Record<string, Prop>, input, "");
}

function held(
  props: Record<string, Prop>,
  input: Record<string, unknown>,
  at: string,
): Record<string, unknown> {
  const out = { ...input };
  for (const [key, prop] of Object.entries(props)) {
    const name = at ? `${at}.${key}` : key;
    if (out[key] === undefined) {
      if (prop.default !== undefined) out[key] = prop.default;
    } else out[key] = valued(prop, out[key], name);
  }
  return out;
}

function valued(prop: Prop, v: unknown, name: string): unknown {
  const range = rangeOf(prop);
  if ((prop.type === "integer" || prop.type === "number") && isBounded(prop)) {
    const whole = prop.type === "integer";
    const fits = isNum(v) && (!whole || Number.isInteger(v)) &&
      (!isNum(prop.minimum) || v >= prop.minimum) && (!isNum(prop.maximum) || v <= prop.maximum);
    if (!fits) {
      throw new Error(
        `${name} is ${whole ? "an integer" : "a number"}${range ? `, ${range}` : ""}: got ` +
          JSON.stringify(v),
      );
    }
    return v;
  }
  if (prop.type === "array" && Array.isArray(v)) {
    if (isNum(prop.maxItems) && v.length > prop.maxItems) {
      throw new Error(`${name} holds up to ${prop.maxItems}: got ${v.length}`);
    }
    const each = isObject(prop.items) ? prop.items : undefined;
    return each ? v.map((x, i) => valued(each, x, `${name}[${i}]`)) : v;
  }
  if (isObject(v) && isObject(prop.properties)) {
    return held(prop.properties as Record<string, Prop>, v, name);
  }
  return v;
}
