# pi-orcarouter-provider

[OrcaRouter](https://orcarouter.ai) provider for [Pi](https://pi.dev).

> Community project, not affiliated with or endorsed by OrcaRouter.

- Native provider `orcarouter` with the full chat catalog (166 models at the time of writing), discovered from OrcaRouter's public catalog and cached for 24 hours.
- `/login orcarouter`, with the `ORCAROUTER_API_KEY` environment variable as a fallback.
- Safeguards for free (`-free`) models, based on measurements of the gateway (see "Free models" below).
- `/orca-usage` shows account usage, balance and credits. `/orcarouter-refresh` refreshes the catalog.
- A balance status (`Orca balance $12.34`) that is visible only while an OrcaRouter model is selected.

Requests use Pi's built-in OpenAI Chat Completions transport. There is no custom stream parser.

## Install

```bash
pi install npm:pi-orcarouter-provider
# or from git:   pi install git:github.com/ijin/pi-orcarouter-provider
# try once:      pi -e npm:pi-orcarouter-provider
```

Install through **one** route. Pi identifies npm packages by name and git packages by URL, so installing both loads the extension twice.

Then run `/login orcarouter` and pick a model with `/model`. Model ids keep OrcaRouter's names, e.g. `orcarouter/deepseek/deepseek-v4-flash-free`.

## Catalog

The catalog merges the anonymous endpoints `/v1/models` (prices and limits) and `/api/pricing` (free-alias metadata, modalities, parameters). Your key is never sent to them: OrcaRouter answers a stale key with 401 instead of the public catalog.

| Rule | Why |
| --- | --- |
| Excluded: text-to-speech, embedding, image-generation, video and detector models, delisted or locked entries | They are not chat models. |
| Not used to exclude: a missing `tools` entry in `supported_parameters` | The catalog is incomplete. MiniMax M2.7 and deepseek-reasoner call tools anyway. |
| Prices come from `*_per_million` fields (per-token × 1e6 as a fallback), including cache reads | The `/api/pricing` ratios do not convert to USD consistently. |
| Missing or zero limits become 128K context / 32,768 output tokens | Unknown is not unlimited. |
| `orcarouter/auto` is added even though `/v1/models` omits it | It is documented and works. |
| Routers and models with tiered or timed pricing show base or zero prices | Session cost is an estimate. `/orca-usage` reports what was billed. |

Every model sends `system` (never `developer`, which GLM rejects), uses `max_completion_tokens`, and omits `store`.

## Thinking levels

These were measured with OrcaRouter's `reasoning_effort` parameter. A dash means the level is hidden.

| Model | off sends | Notes |
| --- | --- | --- |
| DeepSeek V4 Flash (free and paid) | `none` | `minimal` also disables thinking, so it is hidden as a duplicate. |
| DeepSeek V4.1 Flash, HY3 (free and paid) | `none` | |
| HY4 preview (free and paid) | `none` | `max` is rejected with a 400, so it is hidden. |
| GLM 5.3 Flash (free and paid) | — | No value disables thinking: the free route rejects `none`, and the paid route only reduces it. Selecting off falls back to `minimal`. |
| `orcarouter/free` | `minimal` | Accepted by every free model it can route to. |
| Other reasoning models | omitted | Not measured. Pi's off sends no `reasoning_effort`, so these models use their default, which may include thinking. |

## Free models

Free models (`*-free`, `orcarouter/free`) cost nothing but have their own limits. Accounts below OrcaRouter's lifetime-spend threshold also have a per-request **prompt cap**. Measured on 2026-10-08:

- **The cap.** A request is rejected when the gateway's own token estimate exceeds **128,000**. It is the same for every free model. The estimate is a weighted count of words, symbols and whitespace; it counts replayed `reasoning_content` in full and costs about 500 per image regardless of image size.
- **Context window: 88K.** On real content (code, docs, JSON, English and Japanese prose) the gateway's estimate is 0.81–1.22 times the token count the model reports. 88K therefore leaves about 19% margin, and Pi compacts before the cap in normal use.
- **Stale reasoning is stripped.** Pi resends reasoning from earlier turns. The models ignore it (reported tokens are unchanged), but the cap counts it, so it is removed from free-model requests. Reasoning inside the current turn (tool loops) is kept.
- **A cap rejection triggers compaction.** If the cap is still hit (`err_free_prompt_cap`), the error is converted to a context overflow, so Pi compacts and retries instead of failing. This was verified end to end.
- **Other limits are left alone.** Rate limits, `free_quota_exhausted` (the separate `orcarouter/free` allowance) and access denials are never converted. Free requests never fall back to paid models.

To change the window, for example after crossing the paid-tier threshold, add an override in `~/.pi/agent/models.json`:

```json
{ "providers": { "orcarouter": { "modelOverrides": {
  "deepseek/deepseek-v4-flash-free": { "contextWindow": 120000 }
} } } }
```

## Commands and status

- `/orca-usage` shows lifetime billed usage, paid balance, promo and model credits with expiry. Data that is missing is reported as unavailable, never as `$0`. Remaining free-tier requests are not available from the API.
- `/orcarouter-refresh` refetches the catalog. On failure it keeps the previous catalog and says so.
- The status refreshes on selection and after completed agent runs, at most once a minute, with no idle polling. A failed refresh keeps the last value marked `(stale)`. Account data is held in memory only, scoped to the current key.

## Migrating from a `models.json` provider

If you configured OrcaRouter by hand (for example a provider named `orca-router`), remove that provider and any standalone `orca-usage` extension after installing this package. The two provider ids would otherwise show up as duplicates. Also update `enabledModels` entries from `orca-router/...` to `orcarouter/...`.

## Development

```bash
npm install          # dev only: Pi host packages are devDependencies (Pi installs packages with --omit=dev)
npm run check        # tsc + node --test (Node >= 22.19 runs the TypeScript sources directly)
npm run snapshot     # refresh src/snapshot.json from the public catalog
pi -e .              # try the working tree in Pi
```

**Never symlink Pi's own packages into this repository's `node_modules`.** `npm install` follows such links and overwrites Pi's installation.

How each policy was measured: [docs/MEASUREMENTS.md](docs/MEASUREMENTS.md).

## License

MIT
