import type { Balance, Usage } from "./account.ts";

function dollars(value: number, digits = 2): string {
	return `$${value.toFixed(digits)}`;
}

function progressBar(percent: number, width = 20): string {
	const clamped = Math.max(0, Math.min(100, percent));
	const scaled = (clamped / 100) * width;
	const full = Math.floor(scaled);
	const fractions = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"];
	const partial = full < width ? fractions[Math.floor((scaled - full) * 8)] : "";
	const empty = Math.max(0, width - full - (partial ? 1 : 0));
	return `[${"█".repeat(full)}${partial}${"░".repeat(empty)}]`;
}

/**
 * Account-wide view. Either half may be missing (its request failed); missing data is reported
 * as unavailable, never as zero.
 */
export function formatUsageReport(
	balance: Balance | undefined,
	usage: Usage | undefined,
	errors: string[],
	formatDate: (unixSeconds: number) => string = (s) => new Date(s * 1000).toLocaleString(),
): string {
	const lines = ["OrcaRouter account"];
	lines.push(usage ? `Total billed (all time): ${dollars(usage.totalUsd, 4)}` : "Total billed: unavailable");

	if (balance) {
		const usd = balance.unit === "USD";
		lines.push(`Paid balance: ${usd ? dollars(balance.paidBalance, 4) : `${balance.paidBalance} ${balance.unit}`}`);
		for (const promo of balance.promoCredits) {
			const scope = promo.scope ? ` (${promo.scope})` : "";
			const expiry = promo.expiresAt ? `, expires ${formatDate(promo.expiresAt)}` : "";
			if (promo.initial && promo.initial > 0) {
				const used = Math.max(0, promo.initial - promo.balance);
				const percent = (used / promo.initial) * 100;
				lines.push(
					`Promo credit${scope}: ${progressBar(percent)} ${percent.toFixed(1)}% used`,
					`  ${dollars(promo.balance, 4)} of ${dollars(promo.initial)} left${expiry}`,
				);
			} else {
				lines.push(`Promo credit${scope}: ${dollars(promo.balance, 4)} left${expiry}`);
			}
		}
		for (const credit of balance.freeCredits) {
			lines.push(`Model credit${credit.model ? ` (${credit.model})` : ""}: ${dollars(credit.usd, 4)}`);
		}
	} else {
		lines.push("Paid balance: unavailable");
	}

	lines.push(
		"Free-tier requests remaining: not exposed by OrcaRouter.",
		"Session tokens and cost: see /session (estimates; router and free routes may differ from billing).",
	);
	for (const error of errors) lines.push(`Error: ${error}`);
	return lines.join("\n");
}
