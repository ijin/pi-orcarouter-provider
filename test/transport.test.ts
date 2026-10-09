/**
 * Drives Pi's real OpenAI Chat Completions transport through the provider with a fake fetch,
 * checking the request body that would reach OrcaRouter.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { CatalogStore } from "../src/catalog.ts";
import { createOrcaRouterProvider } from "../src/provider.ts";

const provider = createOrcaRouterProvider(new CatalogStore({ cacheDir: "/nonexistent", fetch: (() => {}) as never }));
const model = (id: string) => {
	const m = provider.getModels().find((x) => x.id === id);
	assert.ok(m, id);
	return m;
};

function capture() {
	const bodies: any[] = [];
	const original = globalThis.fetch;
	globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
		bodies.push(JSON.parse(String(init?.body)));
		const sse =
			'data: {"id":"x","object":"chat.completion.chunk","created":0,"model":"m","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":"stop"}]}\n\n' +
			'data: {"id":"x","object":"chat.completion.chunk","created":0,"model":"m","choices":[],"usage":{"prompt_tokens":10,"completion_tokens":1,"total_tokens":11}}\n\n' +
			"data: [DONE]\n\n";
		return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
	}) as typeof fetch;
	return { bodies, restore: () => void (globalThis.fetch = original) };
}

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

function transcript(modelId: string) {
	return {
		messages: [
			{ role: "system", content: "You are terse.", timestamp: 0 },
			{ role: "user", content: "first question", timestamp: 1 },
			{
				role: "assistant",
				api: "openai-completions",
				provider: "orcarouter",
				model: modelId,
				stopReason: "stop",
				usage,
				timestamp: 2,
				content: [
					{ type: "thinking", thinking: "OLD-TURN-REASONING", thinkingSignature: "reasoning_content" },
					{ type: "text", text: "first answer" },
				],
			},
			{ role: "user", content: "second question", timestamp: 3 },
		],
	};
}

async function send(modelId: string, reasoning?: string) {
	const cap = capture();
	try {
		const stream = provider.streamSimple(model(modelId) as never, transcript(modelId) as never, { apiKey: "k", reasoning } as never);
		for await (const _event of stream) {
			// drain
		}
	} finally {
		cap.restore();
	}
	assert.equal(cap.bodies.length, 1);
	return cap.bodies[0];
}

test("free route: earlier-turn reasoning is stripped on the wire; request shape matches verified compat", async () => {
	const body = await send("deepseek/deepseek-v4-flash-free", "off");
	const assistant = body.messages.find((m: any) => m.role === "assistant");
	assert.equal(assistant.content, "first answer");
	assert.equal(JSON.stringify(body).includes("OLD-TURN-REASONING"), false);
	assert.equal(body.messages[0].role, "system", "never `developer`");
	assert.equal(body.reasoning_effort, "none", "off maps to the measured disabling value");
	assert.ok("max_completion_tokens" in body && !("max_tokens" in body));
	assert.equal("store" in body, false);
	assert.equal(body.stream, true);
});

test("paid route: payload is left as Pi builds it (reasoning replay kept)", async () => {
	const body = await send("deepseek/deepseek-v4.1-flash", "high");
	assert.equal(JSON.stringify(body).includes("OLD-TURN-REASONING"), true);
	assert.equal(body.reasoning_effort, "high");
});

test("GLM free: `off` is not offered, so Pi clamps it to a level the model accepts", async () => {
	const body = await send("z-ai/glm-5.3-flash-free", "off");
	assert.equal(body.reasoning_effort, "minimal");
});

test("orcarouter/free: off sends `minimal`, accepted by every free member", async () => {
	const body = await send("orcarouter/free", "off");
	assert.equal(body.reasoning_effort, "minimal");
	assert.equal(body.model, "orcarouter/free");
});
