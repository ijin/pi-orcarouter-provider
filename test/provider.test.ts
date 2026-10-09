import assert from "node:assert/strict";
import { test } from "node:test";
import { CACHE_FORMAT_VERSION, type CatalogSnapshot, CatalogStore } from "../src/catalog.ts";
import { POLICY_VERSION } from "../src/metadata.ts";
import { createOrcaRouterProvider, withFreeRouteSafeguard } from "../src/provider.ts";

const snap = (id: string, fetchedAt = 1_000): CatalogSnapshot => ({
	format: CACHE_FORMAT_VERSION,
	policyVersion: POLICY_VERSION,
	fetchedAt,
	raw: { models: [{ id, supported_endpoint_types: ["openai"] }], pricing: [] },
});

function fakeStore(opts: { stale: boolean; fail?: boolean }) {
	let current = snap("old/model");
	let refreshes = 0;
	const store = {
		get snapshot() {
			return current;
		},
		isStale: () => opts.stale,
		refresh: async () => {
			refreshes++;
			if (opts.fail) throw new Error("offline");
			current = snap("new/model", 2_000);
			return current;
		},
	} as unknown as CatalogStore;
	return { store, count: () => refreshes };
}

function context(overrides: Partial<{ allowNetwork: boolean; force: boolean }>) {
	const published: number[] = [];
	return {
		published,
		ctx: {
			allowNetwork: overrides.allowNetwork ?? true,
			force: overrides.force,
			signal: new AbortController().signal,
			publish: async (p: { update?: () => void }) => {
				p.update?.();
				published.push(1);
				return true;
			},
		} as never,
	};
}

test("refresh: offline and fresh catalogs never fetch; stale ones do", async () => {
	const fresh = fakeStore({ stale: false });
	const p1 = createOrcaRouterProvider(fresh.store);
	await p1.refreshModels!(context({ allowNetwork: false }).ctx);
	await p1.refreshModels!(context({}).ctx);
	assert.equal(fresh.count(), 0);

	const stale = fakeStore({ stale: true });
	const p2 = createOrcaRouterProvider(stale.store);
	await p2.refreshModels!(context({ allowNetwork: false }).ctx);
	assert.equal(stale.count(), 0, "PI_OFFLINE / cache-only init");
	await p2.refreshModels!(context({}).ctx);
	assert.equal(stale.count(), 1);
	assert.ok(p2.getModels().some((m) => m.id === "new/model"));
});

test("refresh: forced refresh fetches and surfaces failures; background failures stay quiet", async () => {
	const failing = fakeStore({ stale: true, fail: true });
	const provider = createOrcaRouterProvider(failing.store);
	await provider.refreshModels!(context({}).ctx); // quiet
	await assert.rejects(provider.refreshModels!(context({ force: true }).ctx), /offline/);
	assert.ok(provider.getModels().some((m) => m.id === "old/model"), "previous catalog kept");
});

test("free-route payload hook chains the caller's onPayload, then strips stale reasoning", async () => {
	const seen: unknown[] = [];
	const options = {
		apiKey: "k",
		onPayload: (payload: unknown) => {
			seen.push(payload);
			return { ...(payload as object), tagged: true };
		},
	};
	const freeModel = { id: "tencent/hy3-free" } as never;
	const wrapped = withFreeRouteSafeguard(freeModel, options);
	assert.equal(wrapped.apiKey, "k");
	const payload = {
		messages: [
			{ role: "user", content: "a" },
			{ role: "assistant", content: "b", reasoning_content: "r" },
			{ role: "user", content: "c" },
		],
	};
	const out = (await (wrapped.onPayload as (p: unknown, m: unknown) => unknown)(payload, freeModel)) as any;
	assert.equal(seen.length, 1);
	assert.equal(out.tagged, true);
	assert.equal("reasoning_content" in out.messages[1], false);

	const paid = { id: "deepseek/deepseek-v4.1-flash" } as never;
	assert.equal(withFreeRouteSafeguard(paid, options), options, "paid routes untouched");
	const bare = withFreeRouteSafeguard(freeModel, undefined as { onPayload?: never } | undefined);
	assert.equal(typeof bare?.onPayload, "function");
});

test("provider exposes /login api-key auth with env fallback", async () => {
	const provider = createOrcaRouterProvider(fakeStore({ stale: false }).store);
	assert.equal(provider.id, "orcarouter");
	const auth = provider.auth.apiKey!;
	assert.equal(typeof auth.login, "function");
	const signal = new AbortController().signal;
	const ctx = { env: async (n: string) => (n === "ORCAROUTER_API_KEY" ? "env-key" : undefined), fileExists: async () => false };
	assert.equal((await auth.resolve({ ctx, signal }))?.auth.apiKey, "env-key");
	assert.equal((await auth.resolve({ ctx, credential: { type: "api_key", key: "stored" }, signal }))?.auth.apiKey, "stored");
});
