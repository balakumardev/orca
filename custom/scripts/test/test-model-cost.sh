#!/usr/bin/env bash
# Test for lib.sh: deepinfra_prices (the price of a model as DeepInfra bills it now, read from its public model list) and model_cost_usd
# (what a round cost). No network: the model list is a file. Run: bash custom/scripts/test/test-model-cost.sh      (needs bash, curl, jq)
#
# The list prices in DeepInfra's API are before the promotional discount, and the cached price is a fraction of the input price; both are
# applied. The token counts below are the real ones of the three model rounds of the 2026-11-21 16:51Z sync run (Flash, Flash, Pro).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
scripts="$(cd "$here/.." && pwd)"
for t in curl jq awk; do command -v "$t" >/dev/null 2>&1 || { echo "missing tool: $t"; exit 2; }; done
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
# shellcheck source=../lib.sh
. "$scripts/lib.sh"

fails=0
ok() { printf 'ok   %s\n' "$1"; }
bad() { printf 'FAIL %s\n' "$1"; fails=$((fails + 1)); }
eq() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1: expected [$3], got [$2]"; fi; }

cat > "$tmp/list.json" <<'JSON'
[{"model_name":"deepseek-ai/DeepSeek-V4.1-Flash-1017","type":"text-generation","pricing":{"type":"tokens","discount":0.51,"cents_per_input_token":0.00002,"cents_per_output_token":0.00006,"rate_per_input_token_cached":0.03}},
 {"model_name":"deepseek-ai/DeepSeek-V4-Pro-0813","type":"text-generation","pricing":{"type":"tokens","discount":null,"cents_per_input_token":0.00013,"cents_per_output_token":0.00026,"rate_per_input_token_cached":0.07692308}},
 {"model_name":"x/discount-out-of-range","type":"text-generation","pricing":{"type":"tokens","discount":1.5,"cents_per_input_token":0.0001,"cents_per_output_token":0.0002,"rate_per_input_token_cached":0.5}},
 {"model_name":"x/no-cached-rate","type":"text-generation","pricing":{"type":"tokens","discount":null,"cents_per_input_token":0.0001,"cents_per_output_token":0.0002}},
 {"model_name":"x/per-image","type":"text-to-image","pricing":{"type":"images","cents_per_image":1}},
 {"model_name":"x/price-is-a-string","type":"text-generation","pricing":{"type":"tokens","cents_per_input_token":"cheap","cents_per_output_token":0.0002}}]
JSON
prices() { DEEPINFRA_MODELS_URL="file://$tmp/list.json" deepinfra_prices "$1"; }

echo "deepinfra_prices: the price as billed now, in dollars per million tokens"
eq "Flash-1017: the 51% promotion is applied to input, output and cached input" "$(prices deepseek-ai/DeepSeek-V4.1-Flash-1017)" "0.098 0.294 0.00294"
eq "Pro-0813: no discount, cached input is a fraction of the input price" "$(prices deepseek-ai/DeepSeek-V4-Pro-0813)" "1.3 2.6 0.1"
eq "a discount outside 0..1 is ignored, not applied" "$(prices x/discount-out-of-range)" "1 2 0.5"
eq "no cached rate: cached input is priced like input (never cheaper than listed)" "$(prices x/no-cached-rate)" "1 2 1"
eq "a model that is not in the list: nothing, so the caller uses its table" "$(prices deepseek-ai/Not-There)" ""
eq "a model that is not priced per token: nothing" "$(prices x/per-image)" ""
eq "a price that is not a number: nothing" "$(prices x/price-is-a-string)" ""
eq "a list that cannot be read: nothing" "$(DEEPINFRA_MODELS_URL="file://$tmp/missing.json" deepinfra_prices deepseek-ai/DeepSeek-V4-Pro-0813)" ""
echo '{"error":"rate limited"}' > "$tmp/err.json"
eq "an error object instead of the list: nothing" "$(DEEPINFRA_MODELS_URL="file://$tmp/err.json" deepinfra_prices deepseek-ai/DeepSeek-V4-Pro-0813)" ""
echo 'not json' > "$tmp/junk.json"
eq "a list that is not JSON: nothing" "$(DEEPINFRA_MODELS_URL="file://$tmp/junk.json" deepinfra_prices deepseek-ai/DeepSeek-V4-Pro-0813)" ""

echo "model_cost_usd: fresh prompt tokens, cached prompt tokens, output tokens, then the three prices"
eq "round 1 (Flash, 126 turns): about 4 cents" "$(model_cost_usd 108282 4741632 40358 0.098 0.00294 0.294)" "0.0364"
eq "round 2 (Flash, 128 turns)" "$(model_cost_usd 148583 6142208 42506 0.098 0.00294 0.294)" "0.0451"
eq "round 3 (Pro, 117 turns): the Pro round is almost all of the run" "$(model_cost_usd 208519 5132544 43890 1.30 0.10 2.60)" "0.8984"
eq "no tokens, no cost" "$(model_cost_usd 0 0 0 1.30 0.10 2.60)" "0.0000"
eq "the same Pro round with every prompt token at the full price (the old upper bound) is about 8 times as much" "$(model_cost_usd 5341063 0 43890 1.30 1.30 2.60)" "7.0575"

exit "$([ "$fails" -eq 0 ] && echo 0 || echo 1)"
