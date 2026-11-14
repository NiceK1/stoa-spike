#!/bin/bash
# usage: convert_to_gguf.sh <tuned_model_dir> <base_model_dir> <out_prefix>
# Writes <out_prefix>-q8_0.gguf, and <out_prefix>-q4_k_m.gguf when llama-quantize has been built.
set -e
cd /data/gemma
PY="nice -n 15 venv/bin/python"
QUANTIZE=llama.cpp/build/bin/llama-quantize

# transformers 5 saves only tokenizer.json and a slimmed tokenizer_config.json; converted from those,
# <start_of_turn> is no longer a special token in the GGUF and prompts tokenise differently from training.
for f in tokenizer.model tokenizer.json tokenizer_config.json added_tokens.json special_tokens_map.json chat_template.jinja; do
  [ -f "$2/$f" ] && cp "$2/$f" "$1/$f"
done

$PY llama.cpp/convert_hf_to_gguf.py "$1" --outfile "$3-q8_0.gguf" --outtype q8_0
if [ -x "$QUANTIZE" ]; then
  $PY llama.cpp/convert_hf_to_gguf.py "$1" --outfile "$3-f16.gguf" --outtype f16
  nice -n 15 "$QUANTIZE" "$3-f16.gguf" "$3-q4_k_m.gguf" Q4_K_M
  rm "$3-f16.gguf"
fi
ls -la "$3"-*.gguf
