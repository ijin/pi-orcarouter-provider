/**
 * OrcaRouter provider for Pi.
 *
 * - Native provider `orcarouter` (full chat catalog, /login or ORCAROUTER_API_KEY).
 * - Free-tier safeguards: stale reasoning is stripped from free-route payloads; the gateway's
 *   prompt-cap rejection is normalized to a context overflow so Pi compacts and retries.
 * - /orca-usage (account view), /orcarouter-refresh (catalog), and a balance status shown only
 *   while an OrcaRouter model is selected.
 */
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { AccountService, type Balance, type Usage } from "./account.ts";
import { BalanceStatus, STATUS_KEY } from "./balance-status.ts";
import { CatalogStore } from "./catalog.ts";
import { PROVIDER_ID } from "./metadata.ts";
import { createOrcaRouterProvider } from "./provider.ts";
import { normalizeFreePromptCapError } from "./safeguards.ts";
import { formatUsageReport } from "./usage-command.ts";

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export default async function orcaRouter(pi: ExtensionAPI): Promise<void> {
	const catalog = new CatalogStore({ cacheDir: join(getAgentDir(), "cache", "orcarouter"), fetch: fetch as never });
	await catalog.loadCache();
	const provider = createOrcaRouterProvider(catalog);
	pi.registerProvider(provider);

	let latest: ExtensionContext | undefined;
	const account = new AccountService({
		fetch: fetch as never,
		getApiKey: async () => latest?.modelRegistry.getApiKeyForProvider(PROVIDER_ID),
	});
	const status = new BalanceStatus(account);
	const quietly = (promise: Promise<unknown>) => void promise.catch(() => {});
	// Checked at session start and after every turn, so long-running sessions also pick up the
	// daily catalog refresh. Throttled in CatalogStore so failures don't retry on every turn.
	const refreshCatalogIfStale = (ctx: ExtensionContext) => {
		if (process.env.PI_OFFLINE === undefined && catalog.claimAutoRefresh()) {
			quietly(ctx.modelRegistry.refresh({ providers: [PROVIDER_ID], allowNetwork: true }));
		}
	};

	const track = (ctx: ExtensionContext) => {
		latest = ctx;
		status.attach((text) => ctx.ui.setStatus(STATUS_KEY, text));
	};

	pi.on("session_start", async (_event, ctx) => {
		track(ctx);
		quietly(status.onModelChanged(ctx.model?.provider));
		refreshCatalogIfStale(ctx);
	});

	pi.on("model_select", async (event, ctx) => {
		track(ctx);
		quietly(status.onModelChanged(event.model?.provider));
	});

	pi.on("agent_end", async (_event, ctx) => {
		track(ctx);
		quietly(status.onTurnEnd());
		refreshCatalogIfStale(ctx);
	});

	pi.on("message_end", async (event) => {
		const replacement = normalizeFreePromptCapError(event.message as never);
		return replacement ? { message: replacement } : undefined;
	});

	pi.on("session_shutdown", async () => {
		status.dispose();
	});

	pi.registerCommand("orca-usage", {
		description: "Show OrcaRouter account usage, balance and credits",
		handler: async (_args, ctx) => {
			track(ctx);
			const [balance, usage] = await Promise.allSettled([account.refreshBalance(true), account.usage()]);
			const errors: string[] = [];
			if (balance.status === "rejected") errors.push(`balance: ${errorText(balance.reason)}`);
			if (usage.status === "rejected") errors.push(`usage: ${errorText(usage.reason)}`);
			const report = formatUsageReport(
				balance.status === "fulfilled" ? (balance.value as Balance) : undefined,
				usage.status === "fulfilled" ? (usage.value as Usage) : undefined,
				errors,
			);
			ctx.ui.notify(report, errors.length === 2 ? "error" : errors.length ? "warning" : "info");
			quietly(status.render());
		},
	});

	pi.registerCommand("orcarouter-refresh", {
		description: "Refresh the OrcaRouter model catalog now",
		handler: async (_args, ctx) => {
			track(ctx);
			const result = await ctx.modelRegistry.refresh({ providers: [PROVIDER_ID], allowNetwork: true, force: true });
			const error = result.errors.get(PROVIDER_ID);
			if (error) {
				ctx.ui.notify(`OrcaRouter catalog refresh failed; keeping the previous catalog. ${errorText(error)}`, "error");
				return;
			}
			const fetched = new Date(catalog.snapshot.fetchedAt).toLocaleString();
			ctx.ui.notify(`OrcaRouter catalog: ${provider.getModels().length} chat models (fetched ${fetched}).`, "info");
		},
	});
}
