/**
 * Pure catalog assembly: OrcaRouter public catalog data -> Pi chat models.
 *
 * Every policy below is backed by a measurement in docs/findings.md. Policies
 * apply to exact model ids that were tested; untested models keep catalog
 * metadata and Pi defaults rather than inherited guesses.
 */
import type { Model, ThinkingLevelMap } from "@earendil-works/pi-ai";

export const PROVIDER_ID = "orcarouter";
export const BASE_URL = "https://api.orcarouter.ai/v1";
/** Bump when assembly rules change so cached raw catalogs are rebuilt, not reused blindly. */
export const POLICY_VERSION = 1;

/**
 * Free-tier context policy (findings M1/M3): the gateway rejects requests whose own
 * estimate exceeds 128,000. On real content that estimate is 0.81-1.22x the model's
 * reported prompt tokens, so 88K reported tokens keeps ~19% margin. This is an operating
 * policy for accounts below the paid-tier threshold, not a published limit.
 */
export const FREE_CONTEXT_WINDOW = 88_000;
export const FREE_MAX_TOKENS = 32_768;
/** Used only when the catalog publishes no limit. Unknown is not unlimited. */
export const UNKNOWN_CONTEXT_WINDOW = 128_000;
export const UNKNOWN_MAX_TOKENS = 32_768;

export interface RawModelsEntry {
	id: string;
	name?: string;
	supported_endpoint_types?: string[] | null;
	context_length?: number;
	max_completion_tokens?: number;
	architecture?: { input_modalities?: string[] | null; output_modalities?: string[] | null };
	pricing?: Record<string, string | undefined>;
}

export interface RawPricingEntry {
	model_name: string;
	display_name?: string;
	supported_endpoint_types?: string[] | null;
	context_length?: number;
	max_completion_tokens?: number;
	input_modalities?: string[] | null;
	output_modalities?: string[] | null;
	supported_parameters?: string[] | null;
	is_free_tier?: boolean;
	free_base_model?: string;
	locked?: boolean;
	required_tier?: unknown;
}

export interface RawFreePackageModel {
	free_alias: string;
	base_model: string;
}

export interface RawCatalog {
	models: RawModelsEntry[];
	pricing: RawPricingEntry[];
	delisted?: string[];
	freePackage?: RawFreePackageModel[];
}

type OrcaModel = Model<"openai-completions">;

/** Verified request-format differences (findings F14, Tier 2). */
export const COMPAT = {
	supportsDeveloperRole: false, // GLM rejects `developer` with 400; `system` works everywhere tested
	supportsStore: false, // never needed; omitting a field cannot break a request
	supportsReasoningEffort: true, // gateway's documented unified field; verified on all tested families
	maxTokensField: "max_completion_tokens", // documented and verified
	thinkingFormat: "openai",
} as const;

/**
 * Tested reasoning_effort behavior (findings F12, plus paid checks). `null` hides a level.
 * Unmapped xhigh/max are hidden by Pi automatically; max is mapped only where accepted.
 */
const THINKING_POLICIES: Record<string, ThinkingLevelMap> = {
	// `none` and `minimal` both disable thinking; hide the duplicate `minimal`.
	"deepseek/deepseek-v4-flash": { off: "none", minimal: null, max: "max" },
	"deepseek/deepseek-v4-flash-free": { off: "none", minimal: null, max: "max" },
	// `none` disables; `minimal` still thinks.
	"deepseek/deepseek-v4.1-flash": { off: "none", max: "max" },
	"tencent/hy3": { off: "none", max: "max" },
	"tencent/hy3-free": { off: "none", max: "max" },
	// `max` is rejected with 400 on both routes, so it stays unmapped (hidden).
	"tencent/hy4-preview": { off: "none" },
	"tencent/hy4-preview-free": { off: "none" },
	// No accepted value disables thinking (free rejects `none`; paid only reduces it): hide `off`.
	"z-ai/glm-5.3-flash": { off: null, max: "max" },
	"z-ai/glm-5.3-flash-free": { off: null, max: "max" },
	// Routes to free models; `minimal` is accepted by every free member and disables thinking on
	// the observed target (DeepSeek V4 Flash Free). `none` would fail if GLM were selected.
	"orcarouter/free": { off: "minimal" },
};

/** Models that use the chat endpoint but are not conversational (detectors, gated tiers). */
const NON_CHAT_IDS = new Set(["orca/orcaverify-text1.0", "orca/orcaverify-text1.0-free", "codex-auto-review"]);

/** Documented router not listed by /v1/models (verified to work). */
const STATIC_ROUTERS: RawModelsEntry[] = [
	{ id: "orcarouter/auto", name: "OrcaRouter: Auto", supported_endpoint_types: ["openai"] },
];

/** /v1/models lists routers without display names. */
const ROUTER_NAMES: Record<string, string> = {
	"orcarouter/auto": "OrcaRouter: Auto",
	"orcarouter/free": "OrcaRouter: Free",
	"orcarouter/fusion": "OrcaRouter: Fusion",
	"orcarouter/fusion-flash": "OrcaRouter: Fusion Flash",
	"orcarouter/fusion-mini": "OrcaRouter: Fusion Mini",
};

const ROUTER_POLICIES: Record<string, { contextWindow: number; maxTokens: number; reasoning: boolean }> = {
	"orcarouter/free": { contextWindow: FREE_CONTEXT_WINDOW, maxTokens: FREE_MAX_TOKENS, reasoning: true },
	// Routes per request to models with different limits; keep a conservative common window.
	"orcarouter/auto": { contextWindow: UNKNOWN_CONTEXT_WINDOW, maxTokens: UNKNOWN_MAX_TOKENS, reasoning: true },
};

function positive(value: unknown): number | undefined {
	const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
	return Number.isFinite(n) && n > 0 ? n : undefined;
}

function nonNegative(value: unknown): number | undefined {
	const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
	return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/** Per-million USD prices from /v1/models pricing (finding F9: ratios in /api/pricing are not convertible). */
export function costFromPricing(pricing: RawModelsEntry["pricing"]): OrcaModel["cost"] {
	const p = pricing ?? {};
	const perMillion = (million: string, perToken: string): number => {
		const m = nonNegative(p[million]);
		if (m !== undefined) return m;
		const t = nonNegative(p[perToken]);
		return t !== undefined ? t * 1_000_000 : 0;
	};
	const cacheRead = nonNegative(p.input_cache_read);
	return {
		input: perMillion("prompt_per_million", "prompt"),
		output: perMillion("completion_per_million", "completion"),
		cacheRead: cacheRead !== undefined ? cacheRead * 1_000_000 : 0,
		cacheWrite: 0,
	};
}

export function isFreeModel(id: string, pricing?: RawPricingEntry): boolean {
	return pricing?.is_free_tier === true || id.endsWith("-free") || id === "orcarouter/free";
}

function hasTextOutput(models?: RawModelsEntry, pricing?: RawPricingEntry): boolean {
	const outputs = pricing?.output_modalities ?? models?.architecture?.output_modalities;
	return !outputs || outputs.length === 0 || outputs.includes("text");
}

/**
 * Positive non-chat signals only. `supported_parameters` is incomplete for chat features
 * (MiniMax M2.7 and deepseek-reasoner call tools although `tools` is unlisted), so absence of a
 * parameter is never used to exclude a model.
 */
function isNonChat(id: string, pricing?: RawPricingEntry): boolean {
	if (NON_CHAT_IDS.has(id)) return true;
	if (pricing?.supported_parameters?.includes("voice")) return true; // text-to-speech
	return /(^|[/-])(tts|embedding|imagen)([-.]|$)|text-embedding|gpt-image|-image(-preview)?$|imagine-image/.test(id);
}

function endpointsOf(models?: RawModelsEntry, pricing?: RawPricingEntry): string[] {
	return models?.supported_endpoint_types ?? pricing?.supported_endpoint_types ?? [];
}

/** Assemble Pi chat models. Pure and deterministic for a given raw catalog. */
export function buildModels(raw: RawCatalog): OrcaModel[] {
	const byIdModels = new Map(raw.models.map((m) => [m.id, m]));
	for (const router of STATIC_ROUTERS) if (!byIdModels.has(router.id)) byIdModels.set(router.id, router);
	const byIdPricing = new Map(raw.pricing.map((p) => [p.model_name, p]));
	const delisted = new Set(raw.delisted ?? []);
	const freeBase = new Map((raw.freePackage ?? []).map((f) => [f.free_alias, f.base_model]));

	const ids = new Set([...byIdModels.keys(), ...byIdPricing.keys()]);
	const out: OrcaModel[] = [];
	for (const id of [...ids].sort()) {
		const m = byIdModels.get(id);
		const p = byIdPricing.get(id);
		if (delisted.has(id) || isNonChat(id, p) || p?.locked) continue;
		if (!endpointsOf(m, p).includes("openai")) continue;
		if (!hasTextOutput(m, p)) continue;

		const free = isFreeModel(id, p);
		const baseId = p?.free_base_model ?? freeBase.get(id);
		const base = baseId ? byIdModels.get(baseId) : undefined;
		const basePricing = baseId ? byIdPricing.get(baseId) : undefined;

		const inputs = p?.input_modalities ?? m?.architecture?.input_modalities ?? basePricing?.input_modalities ?? [];
		const params = p?.supported_parameters ?? basePricing?.supported_parameters ?? [];
		const router = ROUTER_POLICIES[id];

		let contextWindow =
			router?.contextWindow ??
			positive(m?.context_length) ??
			positive(p?.context_length) ??
			positive(base?.context_length) ??
			UNKNOWN_CONTEXT_WINDOW;
		let maxTokens =
			router?.maxTokens ??
			positive(m?.max_completion_tokens) ??
			positive(p?.max_completion_tokens) ??
			positive(base?.max_completion_tokens) ??
			UNKNOWN_MAX_TOKENS;
		if (free) {
			contextWindow = Math.min(contextWindow, FREE_CONTEXT_WINDOW);
			maxTokens = Math.min(maxTokens, FREE_MAX_TOKENS);
		}
		maxTokens = Math.min(maxTokens, contextWindow);

		const model: OrcaModel = {
			id,
			name: p?.display_name ?? m?.name ?? ROUTER_NAMES[id] ?? id,
			api: "openai-completions",
			provider: PROVIDER_ID,
			baseUrl: BASE_URL,
			reasoning: router?.reasoning ?? params.includes("reasoning"),
			input: inputs.includes("image") ? ["text", "image"] : ["text"],
			cost: free ? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } : costFromPricing(m?.pricing),
			contextWindow,
			maxTokens,
			compat: { ...COMPAT },
		};
		const thinking = THINKING_POLICIES[id];
		if (thinking && model.reasoning) model.thinkingLevelMap = { ...thinking };
		out.push(model);
	}
	return out;
}

/** True for routes subject to the free-tier prompt cap. */
export function isFreeRoute(modelId: string): boolean {
	return modelId.endsWith("-free") || modelId === "orcarouter/free";
}
