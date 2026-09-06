#!/bin/sh
# mu's audio processor (org config `processors.audio`): audio bytes on stdin → transcript
# text on stdout, non-zero exit = no transcript. ffmpeg decodes whatever the wire sent
# (WhatsApp voice notes are ogg/opus) to the 16 kHz mono audio qwen-asr expects. README.md
# covers the binary, the model, and the flag tuning.
set -e
here="$(cd "$(dirname "$0")" && pwd)"
# a bundled OpenBLAS (lib/) serves when the system has none; harmless when it does
export LD_LIBRARY_PATH="$here/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
# qwen-asr threads itself (-t); a pooled BLAS on top thrashes — one observed run spent
# 25 s of sys time on 1.7 s of work before this was pinned
export OPENBLAS_NUM_THREADS=1

# The org's language in qwen-asr's own vocabulary: the flag takes a language NAME, and the
# language half of LANG (config `locale`) is the tag. An unmapped or absent locale
# transcribes unpinned.
case "${LANG%%[-_.]*}" in
  es) lang=Spanish ;;
  pt) lang=Portuguese ;;
  fr) lang=French ;;
  de) lang=German ;;
  it) lang=Italian ;;
  *)  lang= ;;
esac
# Qwen otherwise sometimes TRANSLATES instead of transcribing — silently, fluently, and
# always into English, the model's dominant language, which nothing downstream can detect.
# Naming the language makes that impossible, and at 1.7b costs nothing: the pinned decode
# keeps the punctuation, casing, and words the free one finds.
if [ -n "$lang" ]; then set -- --language "$lang"; fi

# raw s16le, not wav: a wav header on a pipe can't be backpatched with its sizes, and
# qwen-asr's --stdin takes raw 16 kHz mono s16le natively
ffmpeg -v error -i pipe:0 -ar 16000 -ac 1 -f s16le - |
  "$here/qwen-asr" -d "$here/qwen3-asr-1.7b" -t 4 -S 20 --stdin --silent "$@"
