#!/bin/sh
# mu's audio processor (org config `processors.audio`): audio bytes on stdin → transcript
# text on stdout, non-zero exit = no transcript. ffmpeg decodes whatever the wire sent
# (WhatsApp voice notes are ogg/opus) to the 16 kHz mono wav qwen-asr expects. README.md
# covers the binary, the model, and the flag tuning.
set -e
here="$(cd "$(dirname "$0")" && pwd)"
# a bundled OpenBLAS (lib/) serves when the system has none; harmless when it does
export LD_LIBRARY_PATH="$here/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
# qwen-asr threads itself (-t); a pooled BLAS on top thrashes — one observed run spent
# 25 s of sys time on 1.7 s of work before this was pinned
export OPENBLAS_NUM_THREADS=1

# The org's language (MU_LOCALE, from config `locale`) in qwen-asr's own vocabulary: the
# flag takes a language NAME, not a tag. An unmapped locale leaves it empty and nothing
# below fires.
case "${MU_LOCALE%%[-_]*}" in
  es) lang=Spanish ;;
  pt) lang=Portuguese ;;
  fr) lang=French ;;
  de) lang=German ;;
  it) lang=Italian ;;
  *)  lang= ;;
esac

# raw s16le, not wav: a wav header on a pipe can't be backpatched with its sizes, and
# qwen-asr's --stdin takes raw 16 kHz mono s16le natively. Decoded to a file because the
# retry below needs the same audio twice and stdin only reads once.
pcm="$(mktemp)"
trap 'rm -f "$pcm"' EXIT
# -y: mktemp already created the file, and ffmpeg refuses an existing output otherwise
ffmpeg -y -v error -i pipe:0 -ar 16000 -ac 1 -f s16le "$pcm"

asr() { "$here/qwen-asr" -d "$here/qwen3-asr-0.6b" -t 4 -S 20 --stdin --silent "$@" < "$pcm"; }

text="$(asr)"

# Qwen sometimes TRANSLATES instead of transcribing — silently, fluently, and always into
# English, the model's dominant language. Pinning the language cures it, but that decode
# path drops punctuation and casing and loses the odd word, so pay for it only when the
# free run actually drifted: English function words in a transcript from an org that does
# not speak English. Common Spanish words are none of these, so a match means the sentence
# really did come back in the wrong language.
if [ -n "$lang" ] && [ "$lang" != English ] &&
  printf '%s' "$text" | tr 'A-Z' 'a-z' |
    grep -qE '(^|[^a-z])(the|and|that|you|was|were|with|have|this|very|which|would|about|there)([^a-z]|$)'
then
  text="$(asr --language "$lang")"
fi

printf '%s\n' "$text"
