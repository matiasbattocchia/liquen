# Test journal

One entry per run. What was run, on which commit, what came back, and what it taught.
Numbers come from Harbor's `result.json` and the trial's `trajectory.json`.

## 2026-09-08 — 2.1 regex-log, the adapter's first live trial

- commit `a0f320b` · `terminal-bench/terminal-bench-2-1` · `-k 1` · docker, local
- regex-log: **pass** (reward 1.0). 8 tool calls, 4 closing messages.
- taught: a turn ending in a terminal error disclosed no idle, so the CLI hung to its
  timeout; the idle line could outrun the error row it covered. Both fixed in that commit.

## 2026-09-08 — 2.1 regex-log, the org on the mount and ATIF

- commit `9815111` · `terminal-bench/terminal-bench-2-1` · `-k 1` · docker, local
- regex-log: **pass** (reward 1.0). 7 steps, 55,343 prompt · 8,920 completion ·
  43,504 cached tokens; totals in `result.json`, `trajectory.json` valid, empty stderr.
- taught: nothing new about the harness; the trajectory path works end to end.

## 2026-09-08 — 4.0, two tasks, the proxy fix in place

- commit `1e6561d` · `terminal-bench/terminal-bench@4.0.0` · `-k 1` · docker, local · `-n 2`
- tasks: interleaved-vigenere (Security, 4 cpu · 4 GB) · vpp-loss-divergence (ML, 2 cpu
  · 8 GB, a torch environment). Chosen for the smallest expert-time estimates among
  tasks that need neither a GPU nor an image read.
- interleaved-vigenere: **fail** (reward 0.0), in under a minute. One tool call (read the
  sample cipher and plaintext), then the API stopped the model with `refusal` — the
  streaming classifier, on a classical-cipher cracking instruction. The harness wrote it
  as the terminal error row, disclosed idle, and the CLI exited 0 with the row on stderr;
  `trajectory.json` carries it as a system step. Nothing to fix here: the same refusal
  class the 2.0 batches excluded, and 4.0 kept this task. `-k 5` will show whether the
  classifier fires every time.
- vpp-loss-divergence: running. Mid-run: `pip download megatron-core==0.12.0` and
  `nemo-toolkit` succeeded from the agent's shell — the proxy fix holds under Harbor
  (PIP_CERT + the blind tunnel). Approach: diff the installed package against the pristine
  wheel, 51 files differ, isolating the non-CPU-shim edits. 21 calls in at the 8-minute mark.
- At 40 calls (115 events, 1.06M prompt tokens of which most were cache reads, 24k
  output) the window crossed `compactAt` and the first checkpoint of a bench trial
  landed. The summary names the task, the diff-against-pristine method, the files still
  unreviewed and the one suspicious finding — the thread survived it intact.
- Checkpoint churn. Five checkpoints by 89 calls, after 102 · 154 · 209 · 228 · 249
  events: the later ones bought about twenty events (seven turns) each. The summaries are
  good — the last one names the exact candidate (p2p_communication.py line 170, the
  pristine condition replaced by a literal `False`) and the patch to make — but each
  checkpoint is an uncached prompt rewrite, and the first move after every one was a
  full re-read of `pretrain.py` or a re-run of the diff scan. Mechanics: tool results in a
  coding trial run to 28k characters, the raw-JSON estimate counts them whole, and the
  kept region plus the summary sit near `compactAt` from the moment a checkpoint lands.
  `compactAt`/`keepRecent` default to a chat org's traffic; the bench org's catalog
  should carry a window sized for tool output — the adapter can set it, it is the org's
  knob. Spend at this point: 2.9M prompt tokens, 96k output.
- The agent called the org's `search` tool twice (`loss_trace`, `protected`), reaching for
  a code search; it got its own instruction back, then nothing. Search, schedule and
  cancel address a chat org's log and clock and have no meaning in a trial. Adapter
  change, for the next run: the catalog offers bash alone, and `compactAt` 200k ·
  `keepRecent` 60k · `windowLimit` 2000 size the window for tool output.
- vpp-loss-divergence: **ungraded**. The agent closed after 41 minutes, 457 events, ten
  checkpoints, 5.9M prompt tokens (5.3M cache reads, 0.6M cache writes) and 149k output.
  Its closing claim: every megatron file reverted to the pristine wheel, nemo's wrapper
  carrying only a CPU shim, "root-caused and fixed". The trace says otherwise — the loss
  at iteration 2 after the revert (4.377) is the value the untouched tree produced, so
  reverting 55 files moved nothing the verifier measures, and the claim rests on no
  comparison. The verifier never ran: Docker had 12 GB free on `/`, the verifier image
  carries several GB of CUDA libraries, and the pull died with "no space left on
  device", so `result.json` holds an exception and no reward. Harbor has no regrade;
  the trial's grade needs a re-run on a bigger disk.
- Adapter bug found by the vigenere trajectory: the harness's own rows (an error, a
  cancel) carry the room's address but no session id, and the ATIF query filtered on the
  session id, so the refusal step was missing. Fixed: the query takes the room's rows too.
- What the run taught, in order of cost: (1) the window knobs — ten checkpoints in 41
  minutes, each followed by a re-orientation (`search` for the instruction, `cat -n
  pretrain.py`, the diff scan re-run: four full reads of the harness, four scans); (2)
  `search` offered where it means nothing; (3) local Docker's disk is too small for 4.0's
  verifier images — the root filesystem holds Docker's data and 4 GB remained after the
  run. Both adapter knobs are set for the next run; the disk is the machine's.
