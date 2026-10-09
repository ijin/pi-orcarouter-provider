/**
 * Account data (balance, billed usage). Memory-only; never persisted or logged.
 *
 * Units (findings F10/F11, verified with a controlled request):
 *  - /v1/balance carries `unit: "USD"`; values are dollars.
 *  - /v1/dashboard/billing/usage `total_usage` is cents (rose by 100x the request's cost_usd).
 */
import { createHash } from "node:crypto";
import { BASE_URL } from "./metadata.ts";

export interface Credit {
	model?: string;
	usd: number;
}
export interface PromoCredit {
	balance: number;
	initial?: number;
	scope?: string;
	expiresAt?: number; // unix seconds
}
export interface Balance {
	unit: string;
	paidBalance: number;
	freeCredits: Credit[];
	promoCredits: PromoCredit[];
}
export interface Usage {
	totalUsd: number;
}

function num(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Missing required fields are errors, never silent zeros. */
export function parseBalance(json: unknown): Balance {
	const j = json as Record<string, any>;
	const paid = num(j?.paid_balance);
	if (paid === undefined) throw new Error("balance response has no numeric paid_balance");
	const unit = typeof j.unit === "string" ? j.unit : "USD";
	const freeCredits: Credit[] = (Array.isArray(j.free_credit) ? j.free_credit : [])
		.map((c: any) => ({ model: typeof c?.model === "string" ? c.model : undefined, usd: num(c?.balance_usd) ?? num(c?.balance) }))
		.filter((c: { usd?: number }) => c.usd !== undefined) as Credit[];
	const promoCredits: PromoCredit[] = (Array.isArray(j.promo_credits) ? j.promo_credits : [])
		.filter((c: any) => num(c?.balance) !== undefined)
		.map((c: any) => ({
			balance: num(c.balance) as number,
			initial: num(c.initial_amount),
			scope: typeof c.model_scope === "string" ? c.model_scope : undefined,
			expiresAt: num(c.expires_at),
		}));
	return { unit, paidBalance: paid, freeCredits, promoCredits };
}

export function parseUsage(json: unknown): Usage {
	const cents = num((json as Record<string, unknown>)?.total_usage);
	if (cents === undefined) throw new Error("usage response has no numeric total_usage");
	return { totalUsd: cents / 100 };
}

type FetchLike = (input: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }) => Promise<{
	ok: boolean;
	status: number;
	json(): Promise<unknown>;
}>;

export const AUTO_REFRESH_INTERVAL_MS = 60_000;
const REQUEST_TIMEOUT_MS = 15_000;

interface IdentityState {
	identity: string;
	balance?: Balance;
	balanceAt?: number;
	lastAttemptAt?: number;
	failed: boolean;
	inflight?: Promise<Balance>;
}

export interface AccountServiceOptions {
	fetch: FetchLike;
	getApiKey: () => Promise<string | undefined>;
	now?: () => number;
	baseUrl?: string;
}

export class NotConfiguredError extends Error {
	constructor() {
		super("OrcaRouter is not configured: run /login orcarouter or set ORCAROUTER_API_KEY");
	}
}

export class AccountService {
	private state: IdentityState | undefined;
	private readonly now: () => number;
	private readonly baseUrl: string;
	private readonly options: AccountServiceOptions;
	constructor(options: AccountServiceOptions) {
		this.options = options;
		this.now = options.now ?? Date.now;
		this.baseUrl = (options.baseUrl ?? BASE_URL).replace(/\/$/, "");
	}

	/** Key-derived identity: a short hash, so a credential change never shows another account's data. */
	private async resolve(): Promise<{ key: string; state: IdentityState }> {
		const key = await this.options.getApiKey();
		if (!key) throw new NotConfiguredError();
		const identity = createHash("sha256").update(`${this.baseUrl}\n${key}`).digest("hex").slice(0, 16);
		if (this.state?.identity !== identity) this.state = { identity, failed: false };
		return { key, state: this.state };
	}

	private async getJson(path: string, key: string): Promise<unknown> {
		const response = await this.options.fetch(`${this.baseUrl}${path}`, {
			headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
		if (!response.ok) throw new Error(`GET ${path} returned HTTP ${response.status}`);
		return response.json();
	}

	/** Cached balance for the current identity, without network access. */
	async cached(): Promise<{ balance?: Balance; stale: boolean; identity: string } | undefined> {
		try {
			const { state } = await this.resolve();
			return { balance: state.balance, stale: state.failed, identity: state.identity };
		} catch {
			return undefined;
		}
	}

	/**
	 * Refresh the balance. Automatic refreshes are throttled to one attempt per interval (also after
	 * failures, avoiding retry storms); forced refreshes bypass the throttle. Both share in-flight work.
	 * Resolves to undefined when an automatic refresh was skipped by the throttle.
	 */
	async refreshBalance(force = false): Promise<Balance | undefined> {
		const { key, state } = await this.resolve();
		if (state.inflight) return state.inflight;
		if (!force && state.lastAttemptAt !== undefined && this.now() - state.lastAttemptAt < AUTO_REFRESH_INTERVAL_MS) {
			return undefined;
		}
		state.lastAttemptAt = this.now();
		state.inflight = this.getJson("/balance", key)
			.then(parseBalance)
			.then(
				(balance) => {
					if (this.state === state) {
						state.balance = balance;
						state.balanceAt = this.now();
						state.failed = false;
					}
					return balance;
				},
				(error) => {
					if (this.state === state) state.failed = true;
					throw error;
				},
			)
			.finally(() => {
				state.inflight = undefined;
			});
		return state.inflight;
	}

	async usage(): Promise<Usage> {
		const { key } = await this.resolve();
		return parseUsage(await this.getJson("/dashboard/billing/usage", key));
	}
}
