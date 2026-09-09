/**
 * connect/help.ts — `--help` for every door: the door's usage on stdout, exit 0. Answered
 * before the door parses anything, wherever the flag sits among the args, so no door's
 * own parsing ever sees it.
 */

export function helpFlag(args: string[], usage: string): void {
  if (!args.includes("--help") && !args.includes("-h")) return;
  console.log(usage.trimEnd());
  Deno.exit(0);
}
