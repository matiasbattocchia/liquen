# qwen-asr — local audio transcription

The audio processor mu ships: [huanglizhuo/QwenASR](https://github.com/huanglizhuo/QwenASR)
(a Rust port of antirez/qwen-asr) running the Qwen3-ASR 1.7B model, CPU-only, fully local.
The harness pipes a voice note's bytes into `transcribe.sh` and publishes stdout as a
`<transcript>` event; a note transcribes in roughly 1.7× its own duration on a laptop CPU.

Only the script and this README are versioned — the binary and the model are yours to
install, right here:

```
processors/qwen-asr/
  transcribe.sh      # the processor (versioned)
  qwen-asr           # the binary — you build it (gitignored)
  qwen3-asr-1.7b/    # the model, ~6 GB on disk — you download it (gitignored)
  lib/               # optional bundled OpenBLAS (gitignored)
```

## 1. The binary — build from source

Release binaries up to v0.9.1 hang on short clips on x86 (an unbounded spin-join, fixed
after the release), so build HEAD:

```sh
git clone https://github.com/huanglizhuo/QwenASR
cd QwenASR && cargo build --release        # rustup toolchain; ~2 min
cp target/release/qwen-asr <mu>/processors/qwen-asr/
```

The binary links OpenBLAS dynamically. Install your distro's `openblas` package, or drop
`libopenblas.so*` into `lib/` here — `transcribe.sh` adds it to `LD_LIBRARY_PATH`.
`ffmpeg` must be on `PATH` (it decodes the wire's opus/whatever to wav).

## 2. The model

```sh
cd <mu>/processors/qwen-asr
./qwen-asr download qwen3-asr-1.7b
```

The first run quantizes the weights to int8 beside them (a few extra minutes, once).
`./qwen-asr download` with no argument lists the alternatives — `qwen3-asr-0.6b` is
~2× faster and fits where CPU is scarce, at the cost of accuracy: it loses and mangles
words the 1.7B gets right, and its pinned decode returns them without punctuation or
casing.

## 3. Wire it up

In the org's `data/org/config.jsonc`:

```jsonc
"processors": {
  "audio": "processors/qwen-asr/transcribe.sh"
}
```

(The path resolves against the directory `mu` runs from — the repo root. Any command
honoring the stdin→stdout contract works here; this directory is one implementation.)

Smoke test without the harness:

```sh
ffmpeg -i some-note.ogg -f ogg - | processors/qwen-asr/transcribe.sh
```

## Tuning

`transcribe.sh` pins the flags that measured best on a hybrid laptop CPU (i7-1365U):

- `OPENBLAS_NUM_THREADS=1` — qwen-asr threads itself; a pooled BLAS on top thrashes
  (25 s of sys time for 1.7 s of work, observed).
- `-t 4` — worker threads. More threads drag P-core work onto E-cores; on big machines,
  raise it.
- `--language <name>` — from the org's `locale`, which rides in as `MU_LOCALE`. Left
  unpinned, Qwen sometimes translates a note into English instead of transcribing it —
  silently and fluently, so nothing downstream can tell. Naming the language forecloses
  that, and on this model costs nothing in punctuation, casing, or words.
- `-S 20` — segmented mode, the upstream README's recommendation for batch/offline
  transcription; also what keeps long notes from degrading.
