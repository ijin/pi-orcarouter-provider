import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CACHE_FORMAT_VERSION, CatalogStore, type CatalogSnapshot, fetchRawCatalog } from "../src/catalog.ts";
import { POLICY_VERSION } from "../src/metadata.ts";

const embedded = (): CatalogSnapshot => ({
	format: CACHE_FORMAT_VERSION,
	policyVersion: POLICY_VERSION,
	fetchedAt: 1_000,
	raw: { models: [{ id: "embedded/model", supported_endpoint_types: ["openai"] }], pricing: [] },
});

function fakeFetch(opts: { fail?: boolean; delayMs?: number } = {}) {
	const calls: { url: string; headers?: Record<string, string> }[] = [];
	const impl = async (url: string, init?: { headers?: Record<string, string> }) => {
		calls.push({ url, headers: init?.headers });
		if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
		if (opts.fail) return { ok: false, status: 503, json: async () => ({}) };
		const body = url.endsWith("/v1/models")
			? { data: [{ id: "live/model", supported_endpoint_types: ["openai"], context_length: 1000, pricing: { prompt_per_million: "1", junk: "x" }, extra: "dropped" }] }
			: url.endsWith("/api/pricing")
				? { data: [{ model_name: "live/model", supported_parameters: ["reasoning", "tools", "voice"], quality_score: 9 }], delisted_models: ["gone"] }
				: { data: { models: [{ free_alias: "a-free", base_model: "a" }] } };
		return { ok: true, status: 200, json: async () => body };
	};
	return { impl, calls };
}

test("discovery is anonymous and trims raw data to the fields assembly uses", async () => {
	const { impl, calls } = fakeFetch();
	const raw = await fetchRawCatalog(impl);
	assert.equal(calls.length, 3);
	for (const call of calls) assert.equal(call.headers?.Authorization, undefined, "catalog calls must not send a key");
	assert.deepEqual(raw.models[0], { id: "live/model", supported_endpoint_types: ["openai"], context_length: 1000, pricing: { prompt_per_million: "1" } });
	assert.deepEqual(raw.pricing[0].supported_parameters, ["reasoning", "voice"]);
	assert.deepEqual(raw.delisted, ["gone"]);
	assert.deepEqual(raw.freePackage, [{ free_alias: "a-free", base_model: "a" }]);
});

test("refresh deduplicates concurrent callers and persists atomically", async () => {
	const dir = await mkdtemp(join(tmpdir(), "orca-cat-"));
	const { impl, calls } = fakeFetch({ delayMs: 20 });
	const store = new CatalogStore({ cacheDir: dir, fetch: impl, now: () => 5_000, embedded });
	const [a, b] = await Promise.all([store.refresh(), store.refresh()]);
	assert.equal(a, b);
	assert.equal(calls.length, 3, "one set of requests for two callers");
	assert.equal(store.snapshot.raw.models[0].id, "live/model");
	const files = await readdir(dir);
	assert.deepEqual(files, [`catalog-v${CACHE_FORMAT_VERSION}.json`], "no temp files left behind");
	const onDisk = JSON.parse(await readFile(join(dir, files[0]), "utf8"));
	assert.equal(onDisk.fetchedAt, 5_000);
});

test("a failed refresh keeps the previous catalog", async () => {
	const dir = await mkdtemp(join(tmpdir(), "orca-cat-"));
	const store = new CatalogStore({ cacheDir: dir, fetch: fakeFetch({ fail: true }).impl, embedded });
	await assert.rejects(store.refresh(), /503/);
	assert.equal(store.snapshot.raw.models[0].id, "embedded/model");
});

test("cache loading prefers a valid newer cache and ignores corrupt or older files", async () => {
	const dir = await mkdtemp(join(tmpdir(), "orca-cat-"));
	const path = join(dir, `catalog-v${CACHE_FORMAT_VERSION}.json`);
	await writeFile(path, "{not json");
	const corrupt = new CatalogStore({ cacheDir: dir, fetch: fakeFetch().impl, embedded });
	assert.equal(await corrupt.loadCache(), "embedded");

	await writeFile(path, JSON.stringify({ ...embedded(), fetchedAt: 500 }));
	assert.equal(await new CatalogStore({ cacheDir: dir, fetch: fakeFetch().impl, embedded }).loadCache(), "embedded");

	await writeFile(path, JSON.stringify({ ...embedded(), fetchedAt: 9_000, raw: { models: [{ id: "cached" }], pricing: [] } }));
	const fresh = new CatalogStore({ cacheDir: dir, fetch: fakeFetch().impl, embedded });
	assert.equal(await fresh.loadCache(), "cache");
	assert.equal(fresh.snapshot.raw.models[0].id, "cached");
});

test("staleness: TTL and policy version", () => {
	let now = 1_000;
	const store = new CatalogStore({ cacheDir: "/nonexistent", fetch: fakeFetch().impl, now: () => now, ttlMs: 100, embedded });
	assert.equal(store.isStale(), false);
	now = 1_101;
	assert.equal(store.isStale(), true);
	const oldPolicy = new CatalogStore({
		cacheDir: "/nonexistent",
		fetch: fakeFetch().impl,
		now: () => 1_000,
		embedded: () => ({ ...embedded(), policyVersion: POLICY_VERSION - 1 }),
	});
	assert.equal(oldPolicy.isStale(), true);
});
