import { assertEquals, assertThrows } from "@std/assert";
import { checkProvider, GOOGLE, providerOf } from "./mod.ts";

Deno.test("providerOf: null is Anthropic; an unknown name is refused", () => {
  assertEquals(providerOf(null).name, "anthropic");
  assertEquals(providerOf(undefined).name, "anthropic");
  assertEquals(providerOf("google"), GOOGLE);
  assertThrows(() => providerOf("nope"), Error, 'unknown provider "nope"');
});

Deno.test("checkProvider: a google agent must name a gemini model at a depth the wire has", () => {
  checkProvider({ agentId: "a", provider: "google", model: "gemini-3.5-flash", effort: "high" });
  checkProvider({ agentId: "a", provider: "google", model: "gemini-3.5-flash", effort: null });
  assertThrows(
    () => checkProvider({ agentId: "a", provider: "google", model: "claude-sonnet-5" }),
    Error,
    'model "claude-sonnet-5" is not a google model',
  );
  assertThrows(
    () =>
      checkProvider({ agentId: "a", provider: "google", model: "gemini-3.5-flash", effort: "max" }),
    Error,
    'effort "max" is not one google can express',
  );
  // Anthropic's model names are the API's to judge, and every catalog depth is its own
  checkProvider({ agentId: "a", provider: null, model: "claude-x", effort: "max" });
  checkProvider({ agentId: "a", model: "anything", effort: "xhigh" });
});
