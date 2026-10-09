import assert from "node:assert/strict";
import { test } from "node:test";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { loadEmbeddedSnapshot } from "../src/catalog.ts";
import { buildModels, costFromPricing, FREE_CONTEXT_WINDOW, type RawCatalog } from "../src/metadata.ts";

const raw: RawCatalog = {
	models: [
		{ id: "deepseek/deepseek-v4-flash-free", name: "DeepSeek V4 Flash (Free)", supported_endpoint_types: null, pricing: { request: "0.000000" } },
		{
			id: "deepseek/deepseek-v4-flash",
			supported_endpoint_types: ["openai"],
			context_length: 1048576,
			max_completion_tokens: 384000,
			pricing: { prompt: "0.00000022", completion: "0.00000066", prompt_per_million: "0.22", completion_per_million: "0.66", input_cache_read: "0.000000007" },
		},
		{ id: "z-ai/glm-5.3-flash-free", supported_endpoint_types: null },
		{ id: "tencent/hy4-preview-free", supported_endpoint_types: null },
		{ id: "openai/gpt-image-2", supported_endpoint_types: null },
		{ id: "openai/tts-1", supported_endpoint_types: ["openai"] },
		{ id: "openai/text-embedding-3-small", supported_endpoint_types: ["openai"] },
		{ id: "kling/kling-v3", supported_endpoint_types: ["openai-video"] },
		{ id: "orca/orcaverify-text1.0-free", supported_endpoint_types: null },
		{ id: "minimax/minimax-m2.7", supported_endpoint_types: ["openai"], context_length: 204800, max_completion_tokens: 131072 },
		{ id: "vendor/untested-reasoner", supported_endpoint_types: ["openai"], context_length: 0 },
		{ id: "vendor/old", supported_endpoint_types: ["openai"] },
		{ id: "orcarouter/free", supported_endpoint_types: ["openai"] },
	],
	pricing: [
		{ model_name: "deepseek/deepseek-v4-flash-free", supported_endpoint_types: ["openai"], context_length: 1048576, max_completion_tokens: 384000, input_modalities: ["text"], supported_parameters: ["reasoning"], is_free_tier: true, free_base_model: "deepseek/deepseek-v4-flash" },
		{ model_name: "deepseek/deepseek-v4-flash", supported_parameters: ["reasoning"] },
		{ model_name: "z-ai/glm-5.3-flash-free", supported_endpoint_types: ["openai"], context_length: 1000000, input_modalities: ["text", "image", "video"], supported_parameters: ["reasoning"], is_free_tier: true },
		{ model_name: "tencent/hy4-preview-free", supported_endpoint_types: ["openai"], supported_parameters: ["reasoning"], is_free_tier: true },
		{ model_name: "openai/gpt-image-2", supported_endpoint_types: ["openai"], supported_parameters: [] },
		{ model_name: "openai/tts-1", supported_endpoint_types: ["openai"], supported_parameters: ["voice"] },
		{ model_name: "minimax/minimax-m2.7", supported_parameters: ["reasoning"] }, // no "tools" listed, yet it calls tools
		{ model_name: "vendor/untested-reasoner", supported_parameters: ["reasoning"] },
		{ model_name: "vendor/old", supported_parameters: [] },
		{ model_name: "vendor/locked", supported_endpoint_types: ["openai"], locked: true },
		{ model_name: "vendor/video", supported_endpoint_types: ["openai"], output_modalities: ["video"] },
	],
	delisted: ["vendor/old"],
};

const models = buildModels(raw);
const byId = new Map(models.map((m) => [m.id, m]));

test("admits free stubs with null /v1/models endpoints via /api/pricing and applies the free policy", () => {
	const m = byId.get("deepseek/deepseek-v4-flash-free");
	assert.ok(m);
	assert.equal(m.contextWindow, FREE_CONTEXT_WINDOW);
	assert.equal(m.maxTokens, 32768);
	assert.deepEqual(m.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
	assert.equal(m.reasoning, true);
	assert.equal(m.provider, "orcarouter");
	assert.equal(m.api, "openai-completions");
});

test("excludes non-chat and unavailable entries on positive signals only", () => {
	for (const id of ["openai/gpt-image-2", "openai/tts-1", "openai/text-embedding-3-small", "kling/kling-v3", "orca/orcaverify-text1.0-free", "vendor/old", "vendor/locked", "vendor/video"]) {
		assert.equal(byId.has(id), false, id);
	}
	assert.ok(byId.has("minimax/minimax-m2.7"), "missing `tools` in supported_parameters must not exclude");
});

test("converts per-million prices, falling back to per-token, including cache reads", () => {
	assert.deepEqual(byId.get("deepseek/deepseek-v4-flash")?.cost, { input: 0.22, output: 0.66, cacheRead: 0.007, cacheWrite: 0 });
	assert.deepEqual(costFromPricing({ prompt: "0.000003", completion: "0.000015" }), { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 });
	assert.deepEqual(costFromPricing({ prompt: "not a number", completion: "-1" }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
	assert.deepEqual(costFromPricing(undefined), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
});

test("uses catalog limits; missing or zero limits fall back to conservative unknown values", () => {
	assert.equal(byId.get("deepseek/deepseek-v4-flash")?.contextWindow, 1048576);
	assert.equal(byId.get("minimax/minimax-m2.7")?.maxTokens, 131072);
	assert.equal(byId.get("vendor/untested-reasoner")?.contextWindow, 128000);
});

test("image input only when the catalog lists it", () => {
	assert.deepEqual(byId.get("z-ai/glm-5.3-flash-free")?.input, ["text", "image"]);
	assert.deepEqual(byId.get("deepseek/deepseek-v4-flash-free")?.input, ["text"]);
});

test("thinking levels follow measured behavior, as Pi computes them", () => {
	const levels = (id: string) => getSupportedThinkingLevels(byId.get(id) as never);
	assert.deepEqual(levels("deepseek/deepseek-v4-flash-free"), ["off", "low", "medium", "high", "max"]);
	assert.deepEqual(levels("deepseek/deepseek-v4-flash"), ["off", "low", "medium", "high", "max"]);
	assert.deepEqual(levels("z-ai/glm-5.3-flash-free"), ["minimal", "low", "medium", "high", "max"]);
	assert.deepEqual(levels("tencent/hy4-preview-free"), ["off", "minimal", "low", "medium", "high"]);
	assert.deepEqual(levels("orcarouter/free"), ["off", "minimal", "low", "medium", "high"]);
	assert.equal(byId.get("deepseek/deepseek-v4-flash-free")?.thinkingLevelMap?.off, "none");
	assert.equal(byId.get("orcarouter/free")?.thinkingLevelMap?.off, "minimal");
	// Untested reasoning models keep Pi defaults (no invented map).
	assert.equal(byId.get("vendor/untested-reasoner")?.thinkingLevelMap, undefined);
});

test("routers: static auto entry, readable names, free router policy", () => {
	assert.equal(byId.get("orcarouter/auto")?.name, "OrcaRouter: Auto");
	assert.equal(byId.get("orcarouter/free")?.name, "OrcaRouter: Free");
	assert.equal(byId.get("orcarouter/free")?.contextWindow, FREE_CONTEXT_WINDOW);
});

test("every model carries the verified compat flags", () => {
	for (const m of models) {
		assert.equal(m.compat?.supportsDeveloperRole, false);
		assert.equal(m.compat?.maxTokensField, "max_completion_tokens");
	}
});

test("embedded snapshot builds a plausible catalog", () => {
	const snapshot = loadEmbeddedSnapshot();
	const built = buildModels(snapshot.raw);
	assert.ok(built.length > 100, `only ${built.length} models`);
	const free = built.filter((m) => m.id.endsWith("-free"));
	assert.ok(free.length >= 3);
	for (const m of free) assert.ok(m.contextWindow <= FREE_CONTEXT_WINDOW, m.id);
	for (const m of built) {
		assert.ok(m.maxTokens <= m.contextWindow, m.id);
		assert.ok(Number.isFinite(m.cost.input) && m.cost.input >= 0, m.id);
	}
	assert.equal(new Set(built.map((m) => m.id)).size, built.length, "duplicate ids");
});
