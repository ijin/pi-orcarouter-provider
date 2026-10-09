import assert from "node:assert/strict";
import { test } from "node:test";
import { AccountService, NotConfiguredError, parseBalance, parseUsage } from "../src/account.ts";
import { BalanceStatus, formatBalance } from "../src/balance-status.ts";
import { formatUsageReport } from "../src/usage-command.ts";

const BALANCE = { object: "balance", unit: "USD", paid_balance: 12.345678, free_credit: [{ model: "vendor/media-model", balance: 5, unit: "USD", balance_usd: 5 }], promo_credits: [] };

function harness(opts: { key?: string } = {}) {
	let now = 0;
	let key: string | undefined = opts.key ?? "sk-test";
	const pending: { path: string; resolve: (body: unknown) => void; reject: (e: Error) => void }[] = [];
	const fetch = (url: string) =>
		new Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>((resolve, reject) => {
			pending.push({
				path: new URL(url).pathname,
				resolve: (body) => resolve({ ok: true, status: 200, json: async () => body }),
				reject,
			});
		});
	const service = new AccountService({ fetch: fetch as never, getApiKey: async () => key, now: () => now });
	return {
		service,
		pending,
		advance: (ms: number) => void (now += ms),
		setKey: (k: string | undefined) => void (key = k),
		tick: () => new Promise((r) => setImmediate(r)),
	};
}

test("parses balance and usage with verified units; missing fields are errors, not zero", () => {
	const b = parseBalance(BALANCE);
	assert.equal(b.paidBalance, 12.345678);
	assert.deepEqual(b.freeCredits, [{ model: "vendor/media-model", usd: 5 }]);
	assert.equal(parseUsage({ total_usage: 98765 }).totalUsd, 987.65);
	assert.throws(() => parseBalance({ unit: "USD" }), /paid_balance/);
	assert.throws(() => parseUsage({}), /total_usage/);
	const promo = parseBalance({ paid_balance: 0, promo_credits: [{ balance: 3, initial_amount: 5, model_scope: "x", expires_at: 1700000000 }] });
	assert.deepEqual(promo.promoCredits, [{ balance: 3, initial: 5, scope: "x", expiresAt: 1700000000 }]);
});

test("automatic refreshes are throttled to one attempt per minute; forced refreshes are not", async () => {
	const h = harness();
	const first = h.service.refreshBalance();
	await h.tick();
	h.pending.shift()!.resolve(BALANCE);
	assert.equal((await first)?.paidBalance, 12.345678);
	assert.equal(await h.service.refreshBalance(), undefined, "throttled");
	assert.equal(h.pending.length, 0);
	h.advance(60_001);
	const again = h.service.refreshBalance();
	await h.tick();
	assert.equal(h.pending.length, 1);
	h.pending.shift()!.resolve({ ...BALANCE, paid_balance: 1 });
	assert.equal((await again)?.paidBalance, 1);
	const forced = h.service.refreshBalance(true);
	await h.tick();
	assert.equal(h.pending.length, 1, "force bypasses the throttle");
	h.pending.shift()!.resolve(BALANCE);
	await forced;
});

test("concurrent and forced requests share one in-flight call", async () => {
	const h = harness();
	const a = h.service.refreshBalance();
	await h.tick();
	const b = h.service.refreshBalance(true);
	await h.tick();
	assert.equal(h.pending.length, 1);
	h.pending.shift()!.resolve(BALANCE);
	assert.equal(await a, await b);
});

test("failures are throttled too and mark the cached value stale", async () => {
	const h = harness();
	const ok = h.service.refreshBalance();
	await h.tick();
	h.pending.shift()!.resolve(BALANCE);
	await ok;
	h.advance(60_001);
	const bad = h.service.refreshBalance();
	await h.tick();
	h.pending.shift()!.reject(new Error("network down"));
	await assert.rejects(bad, /network down/);
	const cached = await h.service.cached();
	assert.equal(cached?.balance?.paidBalance, 12.345678);
	assert.equal(cached?.stale, true);
	assert.equal(await h.service.refreshBalance(), undefined, "no retry storm after a failure");
});

test("a credential change never shows the previous account's balance", async () => {
	const h = harness();
	const p = h.service.refreshBalance();
	await h.tick();
	h.setKey("sk-other");
	h.pending.shift()!.resolve(BALANCE);
	await p;
	const cached = await h.service.cached();
	assert.equal(cached?.balance, undefined);
	h.setKey(undefined);
	await assert.rejects(h.service.refreshBalance(true), NotConfiguredError);
	assert.equal(await h.service.cached(), undefined);
});

test("status: visible only for orcarouter; loading then value; never $0 on failure", async () => {
	const h = harness();
	const shown: (string | undefined)[] = [];
	const status = new BalanceStatus(h.service);
	status.attach((t) => shown.push(t));
	const selecting = status.onModelChanged("orcarouter");
	await h.tick();
	assert.equal(shown.at(-1), "Orca balance …");
	h.pending.shift()!.reject(new Error("boom"));
	await selecting;
	assert.equal(shown.at(-1), "Orca balance unavailable");
	assert.ok(!shown.some((t) => t?.includes("$0")));

	await status.onModelChanged("anthropic");
	assert.equal(shown.at(-1), undefined);
});

test("status: switching away during a fetch does not resurrect the status", async () => {
	const h = harness();
	const shown: (string | undefined)[] = [];
	const status = new BalanceStatus(h.service);
	status.attach((t) => shown.push(t));
	const selecting = status.onModelChanged("orcarouter");
	await h.tick();
	await status.onModelChanged("openai");
	h.pending.shift()!.resolve(BALANCE);
	await selecting;
	assert.equal(shown.at(-1), undefined);
	assert.equal(status.isVisible, false);
});

test("status: cached value on reselection, stale marker after a failed refresh, cleared on dispose", async () => {
	const h = harness();
	const shown: (string | undefined)[] = [];
	const status = new BalanceStatus(h.service);
	status.attach((t) => shown.push(t));
	const first = status.onModelChanged("orcarouter");
	await h.tick();
	h.pending.shift()!.resolve(BALANCE);
	await first;
	assert.equal(shown.at(-1), "Orca balance $12.35");
	await status.onModelChanged("openai");
	const back = status.onModelChanged("orcarouter");
	await h.tick();
	assert.equal(shown.at(-1), "Orca balance $12.35", "immediate cached display");
	await back; // throttled: no request
	assert.equal(h.pending.length, 0);
	h.advance(60_001);
	const turn = status.onTurnEnd();
	await h.tick();
	h.pending.shift()!.reject(new Error("timeout"));
	await turn;
	assert.equal(shown.at(-1), "Orca balance $12.35 (stale)");
	status.dispose();
	assert.equal(shown.at(-1), undefined);
});

test("formatting: balance status and the /orca-usage report", () => {
	assert.equal(formatBalance(parseBalance(BALANCE), false), "Orca balance $12.35");
	const report = formatUsageReport(
		parseBalance({ ...BALANCE, promo_credits: [{ balance: 3, initial_amount: 5, expires_at: 1 }] }),
		{ totalUsd: 987.65 },
		[],
		() => "DATE",
	);
	assert.match(report, /Total billed \(all time\): \$987\.6500/);
	assert.match(report, /Paid balance: \$12\.3457/);
	assert.match(report, /40\.0% used/);
	assert.match(report, /\$3\.0000 of \$5\.00 left, expires DATE/);
	assert.match(report, /Model credit \(vendor\/media-model\): \$5\.0000/);
	const partial = formatUsageReport(undefined, undefined, ["balance: HTTP 401"]);
	assert.match(partial, /Paid balance: unavailable/);
	assert.match(partial, /Total billed: unavailable/);
	assert.doesNotMatch(partial, /\$0/);
});
