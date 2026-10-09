# Measurements behind the policies

The policies in this package come from measurements against OrcaRouter's API on 2026-10-08/09 (Pi 1.0.0), using one account below the paid-tier threshold. OrcaRouter tunes limits live, so treat these numbers as a dated snapshot. The runtime fallbacks (prompt-cap normalization, configurable windows) exist because the numbers can change.

Method: before each request was sent, the expected pass or fail result was written down, and bisection was used only when a prediction failed. Probes of the free prompt cap used no thinking and tiny outputs.

## Free-tier prompt cap

- **Rule.** A request is rejected when the gateway's own estimate exceeds **128,000**: an estimate of 128,000 passed and 128,001 failed. The limit is the same for DeepSeek V4 Flash, HY3, HY4 preview and GLM 5.3 Flash (all free).
- **Error.** HTTP 400 `{"error":{"code":"free_rate_limited","metadata":{"reason":"err_free_prompt_cap","retryable":false}}}`.
- **What the gateway counts.** The estimate is a weighted count of text features: word runs, digit runs, CJK characters, symbols, newlines and spaces. It matches the heuristic in the open-source new-api gateway, with differences measured here:
  - Runs of four or more spaces are heavily discounted.
  - `reasoning_content` on earlier assistant messages is **counted in full**.
  - Each image adds about 500, independent of image size.
  - Validation: 10 out of 10 pre-registered pass/fail predictions were correct on real code, Markdown, JSON, TypeScript declarations and Japanese prose, each within ±0.23%.
- **Pi's handling without this package.** The error message matches none of Pi's context-overflow patterns, so Pi neither compacts nor retries.

## Gateway estimate vs. model-reported prompt tokens

| Content | DeepSeek | HY3 | HY4 | GLM |
| --- | --- | --- | --- | --- |
| English prose | 1.22 | 1.21 | 1.21 | 1.19 |
| Markdown docs | 1.13 | 1.15 | 1.16 | 1.17 |
| JS code | 1.08 | 1.12 | 1.10 | 1.15 |
| Japanese prose | 1.10 | 1.01 | 1.07 | 1.01 |
| JSON / TS declarations | 0.99–1.00 | 1.02 | 1.01–1.03 | 1.04–1.07 |
| `ls -lR` output / numeric CSV | 0.83–1.00 | 0.84–0.99 | 0.85–1.03 | 0.81–0.94 |

The cap therefore falls at about 105K reported tokens on real content. **An 88K context window leaves about 19% margin.** Synthetic word salad reaches 1.5, so pathological input can still hit the cap; normalizing the error lets Pi compact and retry in that case.

DeepSeek V4 Flash *Free* sometimes reports the gateway's estimate as `prompt_tokens` instead of the model's own count.

## Replayed reasoning

- **The models ignore it.** Adding 30K characters of `reasoning_content` to an earlier assistant turn left reported `prompt_tokens` unchanged on all four models.
- **The cap counts it.** In a long session with thinking on, this hidden load can reach the cap while Pi's context meter looks low.
- **Removing it is safe.** Omitting `reasoning_content` in a tool loop still produced correct completions on all four models.

This is why the package removes reasoning from earlier turns on free routes.

## `reasoning_effort`

Tested on a trivial prompt, so these results show which values are accepted and which disable thinking, not how effort changes reasoning depth.

| Route | none | minimal | max |
| --- | --- | --- | --- |
| DeepSeek V4 Flash (free and paid) | disables | disables | accepted |
| DeepSeek V4.1 Flash, HY3 (free and paid) | disables | thinks | accepted |
| HY4 preview (free and paid) | disables | thinks | **400** |
| GLM 5.3 Flash free | **400** | thinks | accepted |
| GLM 5.3 Flash paid | reduces only | thinks | accepted |
| `orcarouter/free` | routed to DeepSeek free in tests | | |

GLM rejects the `developer` role with a 400; `system` works on every route tested.

## Catalog quirks

- **Endpoint lists.** `supported_endpoint_types: null` in `/v1/models` marks free aliases, but also some image, video and other entries. `/api/pricing` (anonymous) has the endpoint lists, plus `is_free_tier` and `free_base_model`.
- **Parameter lists.** `supported_parameters` is incomplete: MiniMax M2.7 and deepseek-reasoner call tools even though `tools` is not listed.
- **Prices.** `/api/pricing` ratios do not convert to USD consistently. `/v1/models` `*_per_million` fields do.
- **Routers.** `orcarouter/auto` works but is not listed in `/v1/models`.
- **Images.** GLM 5.3 Flash free accepted a 2.1 MB image.

## Account endpoints

- `/v1/balance` is in USD (`unit: "USD"`).
- `/v1/dashboard/billing/usage` `total_usage` is in **cents**. A controlled request moved it by 100× the `cost_usd` the response reported (`X-OrcaRouter-Include-Cost: true`), and both had settled within 5 seconds.
- The API does not expose remaining free-tier requests.
