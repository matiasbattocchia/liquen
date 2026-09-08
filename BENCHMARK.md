# Terminal-Bench — progress

`mu cli` ([`src/cli.ts`](src/cli.ts)) run against [Terminal-Bench](https://www.tbench.ai)
via a Harbor adapter. Terminal-Bench's methodology — instruction + fresh sandboxed
environment + a programmatic checker over resulting state (files/output, never transcript
prose), binary pass/fail — is used both here (real tasks in containers) and in our own
lightweight [`bench/run.ts`](bench/run.ts) (org-mode behavior).

**Purpose is diagnostic, not a leaderboard chase.** Every batch is mined for harness bugs;
the score is a by-product. mu is a *delegate* harness (conversational, multi-channel); a
trial runs the same harness a resident org runs — one org, one agent, a fresh session per
trial, the catalog's defaults, the default rules (everything but `send` allowed).

## How to run

```sh
cd bench/tbench                 # Harbor adapter (python; harbor installed in .venv)
harbor run -d terminal-bench/terminal-bench-2-1 \
  --agent mu_terminal_bench.mu_agent:MuAgent \
  -m anthropic/claude-sonnet-5 -i <task-name> -n <concurrency> -o <out-dir>
```

The adapter ([`bench/tbench/mu_terminal_bench/mu_agent.py`](bench/tbench/mu_terminal_bench/mu_agent.py))
needs no build step: it uploads the host's `deno` binary and this checkout's `src/`, and
scaffolds the org with `mu init` inside the trial's mounted logs directory, so the org's
log is on the host from its first row whatever ends the trial. The container's user is
the agent; `-m` sets the catalog's model; `MU_EFFORT` in the environment sets its effort.
A trial is one `mu cli --dir <org> --session task` in the task's working directory; the
wall is the task's own agent timeout, the CLI sets none.

Per trial: `agent/mu-out.txt` (the transcript as the REPL paints it), `agent/mu-err.txt`
(error rows and the CLI's own failures), `agent/org/data/log/log.db` (every event), and
`agent/trajectory.json` — the log as an ATIF trajectory, one agent step per turn with its
tool calls, results and spend, which the leaderboard's judge reads and Harbor's token
totals come from.

For the leaderboard: `terminal-bench/terminal-bench@4.0.0` on a GPU-capable sandbox
(`-e modal`), `-k 5`, `--upload --public`, then ask the maintainers to attach the job to
the board.

## Score to date (Sonnet 5, effort default)

Sampled subset of Terminal-Bench 2.0 (89 tasks), excluding vision-dependent and
crypto-cracking tasks. **~25/32 (78%)** after two fix cycles — in/above the published
**Claude Code + Sonnet 5: 74.6%** (full 89-set), at **~1/7th the cost (~$39 vs $288)**.
Single-run deltas — not pass@k-validated; a clean full-89 run would confirm.

| batch | result | notes |
|---|---|---|
| batch 1 (16 tasks) | 12/16 | first run; found the coalescing race + timeout/stall issues |
| batch 2 (16 tasks) | 10/16 | zero harness bugs — all failures task-level |
| cycle-2 re-runs | flipped 3 fail→pass | mailman · configure-git-webserver · write-compressor |

### Passing (representative)
openssl-selfsigned-cert · pypi-server · nginx-request-logging · sqlite-db-truncate ·
db-wal-recovery · git-leak-recovery · qemu-startup · headless-terminal · build-cython-ext ·
git-multibranch · regex-log · log-summary-date-ranges · overfull-hbox · password-recovery ·
vulnerable-secret · count-dataset-tokens · extract-elf · multi-source-data-merger ·
schemelike-metacircular-eval · sqlite-with-gcov · cancel-async-tasks · mailman ·
configure-git-webserver · write-compressor

### Failing, by class
- **vision gap** (no image path until v0.2 media): chess-best-move · gcode-to-text
- **reasoning spiral** (model thinks to the token ceiling, never acts): regex-chess ·
  path-tracing · polyglot-c-py
- **wall-bound, not capability-bound**: train-fasttext — on the fixed binary it did the whole
  pipeline right (compile fasttext *from source* → clean → split → train, `turns=9 tools=9`,
  no spiral) and was mid-training when the 840s wall hit, so `model.bin` never saved. A
  longer budget would likely flip it; the harness is not the limiter.
- **precision/spec**: filter-js-from-html

**Rerun validation (post-fixes #5/#6)**: re-ran the two timed-out tasks on the fixed binary.
Both now **exit cleanly** — no `stop()` wedge, no `max_tokens` dead-end, no 13-min single
turn. regex-chess spends its budget thinking (a genuine loss); train-fasttext is wall-bound
(above). Score unchanged, but every harness pathology the reruns surfaced is gone — the
point of the exercise.

## Harness bugs found & fixed (the real yield)

The benchmark's value is here — six correctness bugs no unit test could catch (all need
real-model latency + real tasks):

1. **Coalescing race** — a message landing between a turn's window-read and its closing's
   publish was swallowed (position-based `unanswered` counted it as already-answered).
   Fix: closings carry `meta.consumed` (the last event id their step read); owed/render/
   compaction all measure against that horizon, not log position.
2. **Stall-retry** — task mode idled forever after an API error (e.g. a credit outage
   mid-run). Fix: bounded alarm re-poke when work is owed but the machine is idle >45s.
3. **Fresh-shell cd tax** — the model re-`cd`'d on nearly every call (sqlite: 7/7) because
   the contract said the shell was fresh. Fix: **sticky cwd** — a pwd sentinel appended to
   each command reports the shell's final dir (persists like a terminal) and preserves the
   real exit code the appended print would otherwise mask. env/venv stays fresh.
4. **Background-pipe hang** — a detached `cmd &` held the stdout pipe open forever, hanging
   the whole call (this was qemu-startup's false failure + several time-starved timeouts).
   Fix: pump via readers, wait for bash's OWN exit, grace-flush 150ms, cancel the readers to
   cut detached descendants loose. Backgrounding (the tool's promised `cmd > log 2>&1 &`
   pattern) now actually works.
5. **Unbounded shutdown** — a mid-outage trial wrote its final trace but never exited: it
   was wedged in `main.stop()`, which awaited an in-flight turn's queue whose model call
   was hung on the dead connection. That defeats the shutdown-reap safety net (the exec
   reap + `log.close` never run) and would hang a real org's shutdown during any API
   outage. Fix: `stop()` caps the settle wait (`stopTimeoutMs`, default 5s), then reaps
   and closes regardless; the orphaned turn is swallowed by the fan-out queue's catch.
   (Surfaced by the network-outage rerun, not a task failure per se — the harness couldn't
   cleanly tear down a poisoned trial.)
6. **`max_tokens` dead-end** — a turn that hit the output ceiling was surfaced as a hard
   `error` and stopped, stranding the work. On regex-chess the model spent a single ~13-min
   turn (64k output tokens ≈ 60-80 tok/s) hitting the limit with nothing usable, then
   stalled. Two fixes: (a) `max_tokens` now **continues** like `pause_turn` — the partial
   turn is committed and xi re-enters (bounded to 3 consecutive overflows), with an advisory
   riding along ("you hit the limit; write large output to files incrementally"); refusal
   stays terminal. (b) task-mode `maxTokens` lowered 64k→32k so a maxed
   turn (~6-9 min) fits under the 840s wall and is interruptible between iterations. A 64k
   turn can *never* finish inside the wall — the cap has to leave headroom for continuation.

## Behavioral audit findings (efficiency, applied)

Pass-side trajectory audit (8 known-good tasks) measured two waste patterns Claude Code
avoids, both since addressed:

- **`tools ≈ turns`** — one command per round-trip, no batching/parallelism. Task doc now
  tells the autonomous agent to chain independent steps, emit parallel calls, and background
  slow work. (Turn counts dropped sharply where applicable: headless-terminal 35→10.)
- **Self-discovery probes** — the model `ls`/`find`/`cat`'d its own docs tree despite the
  complete pull-index. Fix: the index asserts completeness ("nothing else exists; never
  search the docs tree"); greeting went 1 tool call → 0.

## Notes / caveats

- **Dataset**: the scores above are over `terminal-bench@2.0` (89 tasks). The run command
  now names `terminal-bench/terminal-bench-2-1` on the Harbor Hub — the same 89 tasks with
  26 of them repaired (timeouts, resources, reward-hacking robustness), so the next batch
  is not directly comparable to the table. Terminal-Bench 3.0 (74 tasks, 7 domains) is a
  separate, harder set; there is no 4.0.
- **Scores are single-run** — treat as directional. Confirmed flips were re-run; the
  headline % is a projection over the sampled 32, not the full 89.
- **Deliberately excluded**: crypto-cracking tasks (safety-refusal noise) and monster builds
  (compile-compcert) to keep wall time/cost sane; vision tasks are structurally unwinnable
  until v0.2 media.
- Total spend to date **~$39** across all batches (vs Claude Code + Sonnet 5's reported $288
  for the full run).
