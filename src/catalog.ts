/**
 * Catalog discovery and caching.
 *
 * Discovery is anonymous: OrcaRouter documents that a request carrying a stale or invalid key
 * gets 401 instead of the public catalog, so the stored key is never sent here.
 * The cache keeps trimmed raw catalog data, so policy changes rebuild models without a fetch.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { POLICY_VERSION, type RawCatalog, type RawModelsEntry, type RawPricingEntry } from "./metadata.ts";

export const CACHE_FORMAT_VERSION = 1;
export const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
/** Minimum spacing between automatic refresh attempts, so an offline session doesn't retry every turn. */
export const AUTO_REFRESH_RETRY_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = 20_000;
const API_ORIGIN = "https://api.orcarouter.ai";

export interface CatalogSnapshot {
	format: number;
	policyVersion: number;
	fetchedAt: number;
	raw: RawCatalog;
}

type FetchLike = (input: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }) => Promise<{
	ok: boolean;
	status: number;
	json(): Promise<unknown>;
}>;

const KEEP_PARAMS = new Set(["reasoning", "voice"]);

function trimModels(entries: unknown): RawModelsEntry[] {
	if (!Array.isArray(entries)) throw new Error("catalog: /v1/models has no data array");
	return entries
		.filter((e): e is Record<string, any> => !!e && typeof e === "object" && typeof (e as any).id === "string")
		.map((e) => ({
			id: e.id,
			...(typeof e.name === "string" ? { name: e.name } : {}),
			supported_endpoint_types: Array.isArray(e.supported_endpoint_types) ? e.supported_endpoint_types : null,
			...(typeof e.context_length === "number" ? { context_length: e.context_length } : {}),
			...(typeof e.max_completion_tokens === "number" ? { max_completion_tokens: e.max_completion_tokens } : {}),
			...(e.architecture
				? {
						architecture: {
							input_modalities: e.architecture.input_modalities ?? null,
							output_modalities: e.architecture.output_modalities ?? null,
						},
					}
				: {}),
			...(e.pricing
				? {
						pricing: Object.fromEntries(
							["prompt", "completion", "prompt_per_million", "completion_per_million", "input_cache_read"]
								.filter((k) => e.pricing[k] !== undefined)
								.map((k) => [k, String(e.pricing[k])]),
						),
					}
				: {}),
		}));
}

function trimPricing(entries: unknown): RawPricingEntry[] {
	if (!Array.isArray(entries)) throw new Error("catalog: /api/pricing has no data array");
	return entries
		.filter((e): e is Record<string, any> => !!e && typeof e === "object" && typeof (e as any).model_name === "string")
		.map((e) => ({
			model_name: e.model_name,
			...(typeof e.display_name === "string" ? { display_name: e.display_name } : {}),
			supported_endpoint_types: Array.isArray(e.supported_endpoint_types) ? e.supported_endpoint_types : null,
			...(typeof e.context_length === "number" ? { context_length: e.context_length } : {}),
			...(typeof e.max_completion_tokens === "number" ? { max_completion_tokens: e.max_completion_tokens } : {}),
			input_modalities: e.input_modalities ?? null,
			output_modalities: e.output_modalities ?? null,
			supported_parameters: Array.isArray(e.supported_parameters)
				? e.supported_parameters.filter((p: unknown) => typeof p === "string" && KEEP_PARAMS.has(p))
				: null,
			...(e.is_free_tier ? { is_free_tier: true } : {}),
			...(typeof e.free_base_model === "string" ? { free_base_model: e.free_base_model } : {}),
			...(e.locked ? { locked: true } : {}),
		}));
}

/** Fetch the three public endpoints anonymously and trim them to the fields assembly uses. */
export async function fetchRawCatalog(fetchImpl: FetchLike, signal?: AbortSignal): Promise<RawCatalog> {
	const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
	const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
	const get = async (path: string): Promise<any> => {
		const response = await fetchImpl(`${API_ORIGIN}${path}`, { signal: combined, headers: { Accept: "application/json" } });
		if (!response.ok) throw new Error(`catalog: GET ${path} returned ${response.status}`);
		return response.json();
	};
	const [models, pricing, free] = await Promise.all([
		get("/v1/models"),
		get("/api/pricing"),
		get("/api/free-package/public").catch(() => undefined), // optional: aliases are also in /api/pricing
	]);
	const freeModels = Array.isArray(free?.data?.models) ? free.data.models : [];
	return {
		models: trimModels(models?.data),
		pricing: trimPricing(pricing?.data),
		delisted: Array.isArray(pricing?.delisted_models)
			? pricing.delisted_models.filter((d: unknown) => typeof d === "string")
			: [],
		freePackage: freeModels
			.filter((f: any) => typeof f?.free_alias === "string" && typeof f?.base_model === "string")
			.map((f: any) => ({ free_alias: f.free_alias, base_model: f.base_model })),
	};
}

function isSnapshot(value: unknown): value is CatalogSnapshot {
	const v = value as CatalogSnapshot;
	return (
		!!v &&
		v.format === CACHE_FORMAT_VERSION &&
		typeof v.fetchedAt === "number" &&
		Array.isArray(v.raw?.models) &&
		Array.isArray(v.raw?.pricing)
	);
}

export function loadEmbeddedSnapshot(): CatalogSnapshot {
	const path = fileURLToPath(new URL("./snapshot.json", import.meta.url));
	const parsed = JSON.parse(readFileSync(path, "utf8"));
	if (!isSnapshot(parsed)) throw new Error("embedded catalog snapshot is invalid");
	return parsed;
}

export interface CatalogStoreOptions {
	cacheDir: string;
	fetch: FetchLike;
	now?: () => number;
	ttlMs?: number;
	embedded?: () => CatalogSnapshot;
}

/** Holds the current raw catalog; refreshes are deduplicated and persisted atomically. */
export class CatalogStore {
	private current: CatalogSnapshot;
	private inflight: Promise<CatalogSnapshot> | undefined;
	private readonly path: string;
	private readonly now: () => number;
	private readonly ttlMs: number;
	private lastAutoAttempt = Number.NEGATIVE_INFINITY;
	readonly options: CatalogStoreOptions;

	constructor(options: CatalogStoreOptions) {
		this.options = options;
		this.path = join(options.cacheDir, `catalog-v${CACHE_FORMAT_VERSION}.json`);
		this.now = options.now ?? Date.now;
		this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
		this.current = (options.embedded ?? loadEmbeddedSnapshot)();
	}

	get snapshot(): CatalogSnapshot {
		return this.current;
	}

	/** Prefer the disk cache when it is valid and newer than the embedded snapshot. Never throws. */
	async loadCache(): Promise<"cache" | "embedded"> {
		try {
			const parsed = JSON.parse(await readFile(this.path, "utf8"));
			if (isSnapshot(parsed) && parsed.fetchedAt >= this.current.fetchedAt) {
				this.current = parsed;
				return "cache";
			}
		} catch {
			// missing or corrupt cache: keep the embedded snapshot
		}
		return "embedded";
	}

	/** Stale when older than the TTL or produced under a different assembly policy. */
	isStale(): boolean {
		return this.now() - this.current.fetchedAt > this.ttlMs || this.current.policyVersion !== POLICY_VERSION;
	}

	/**
	 * True when an automatic (background) refresh should start now: the catalog is stale and no
	 * automatic attempt was made in the last AUTO_REFRESH_RETRY_MS. A true result records the attempt.
	 */
	claimAutoRefresh(): boolean {
		if (!this.isStale()) return false;
		const now = this.now();
		if (now - this.lastAutoAttempt < AUTO_REFRESH_RETRY_MS) return false;
		this.lastAutoAttempt = now;
		return true;
	}

	/** Fetch a fresh catalog. Concurrent callers share one request; failures keep the last catalog. */
	refresh(signal?: AbortSignal): Promise<CatalogSnapshot> {
		if (!this.inflight) {
			this.inflight = (async () => {
				const raw = await fetchRawCatalog(this.options.fetch, signal);
				if (raw.models.length === 0) throw new Error("catalog: /v1/models returned no models");
				const next: CatalogSnapshot = {
					format: CACHE_FORMAT_VERSION,
					policyVersion: POLICY_VERSION,
					fetchedAt: this.now(),
					raw,
				};
				await this.persist(next);
				this.current = next;
				return next;
			})().finally(() => {
				this.inflight = undefined;
			});
		}
		return this.inflight;
	}

	private async persist(snapshot: CatalogSnapshot): Promise<void> {
		try {
			await mkdir(dirname(this.path), { recursive: true });
			const tmp = `${this.path}.${process.pid}.${this.now()}.tmp`;
			await writeFile(tmp, JSON.stringify(snapshot), "utf8");
			await rename(tmp, this.path);
		} catch {
			// The in-memory catalog still updates; a read-only cache directory is not fatal.
		}
	}
}
