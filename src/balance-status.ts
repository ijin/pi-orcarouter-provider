import type { AccountService, Balance } from "./account.ts";
import { PROVIDER_ID } from "./metadata.ts";

export const STATUS_KEY = "orcarouter-balance";

export function formatBalance(balance: Balance, stale: boolean): string {
	const amount = balance.unit === "USD" ? `$${balance.paidBalance.toFixed(2)}` : `${balance.paidBalance.toFixed(2)} ${balance.unit}`;
	return `Orca balance ${amount}${stale ? " (stale)" : ""}`;
}

/**
 * Shows the wallet balance only while an OrcaRouter model is selected. Results that arrive after
 * the user switched away (or switched credentials) are discarded via an epoch counter.
 */
export class BalanceStatus {
	private visible = false;
	private epoch = 0;
	private sink: (text: string | undefined) => void = () => {};
	private readonly service: AccountService;

	constructor(service: AccountService) {
		this.service = service;
	}

	/** Point the controller at the current UI (contexts are per session). */
	attach(sink: (text: string | undefined) => void): void {
		this.sink = sink;
	}

	get isVisible(): boolean {
		return this.visible;
	}

	async onModelChanged(provider: string | undefined): Promise<void> {
		const epoch = ++this.epoch;
		this.visible = provider === PROVIDER_ID;
		if (!this.visible) {
			this.sink(undefined);
			return;
		}
		const cached = await this.service.cached();
		if (epoch !== this.epoch) return;
		if (!cached) {
			this.sink("Orca balance unavailable");
			return;
		}
		this.sink(cached.balance ? formatBalance(cached.balance, cached.stale) : "Orca balance …");
		// First display fetches immediately; later selections reuse the cache and refresh within the throttle.
		await this.refresh(!cached.balance);
	}

	/** After a completed turn: throttled refresh, only while visible. */
	async onTurnEnd(): Promise<void> {
		if (this.visible) await this.refresh(false);
	}

	/** Re-render from the service cache (e.g. after /orca-usage refreshed it). */
	async render(): Promise<void> {
		const epoch = this.epoch;
		if (!this.visible) return;
		const cached = await this.service.cached();
		if (epoch !== this.epoch || !this.visible) return;
		if (!cached) this.sink("Orca balance unavailable");
		else if (cached.balance) this.sink(formatBalance(cached.balance, cached.stale));
		else if (cached.stale) this.sink("Orca balance unavailable");
	}

	private async refresh(force: boolean): Promise<void> {
		try {
			await this.service.refreshBalance(force);
		} catch {
			// Automatic failures stay quiet; render() shows stale or unavailable.
		}
		await this.render();
	}

	dispose(): void {
		this.epoch++;
		this.visible = false;
		this.sink(undefined);
	}
}
