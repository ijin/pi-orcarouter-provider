import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { isContextOverflow } from "@earendil-works/pi-ai";
import { isRetryableAssistantError } from "@earendil-works/pi-ai/utils/retry";
import { normalizeFreePromptCapError, stripStaleReasoning } from "../src/safeguards.ts";

test("strips reasoning only from assistant messages before the latest user message", () => {
	const payload = {
		model: "deepseek/deepseek-v4-flash-free",
		messages: [
			{ role: "system", content: "s" },
			{ role: "user", content: "q1" },
			{ role: "assistant", content: "a1", reasoning_content: "old thoughts" },
			{ role: "user", content: "q2" },
			{ role: "assistant", content: null, reasoning_content: "current thoughts", tool_calls: [{ id: "c1" }] },
			{ role: "tool", tool_call_id: "c1", content: "ok" },
		],
	};
	const out = stripStaleReasoning(payload) as typeof payload;
	assert.equal("reasoning_content" in out.messages[2], false);
	assert.equal(out.messages[2].content, "a1");
	assert.equal(out.messages[4].reasoning_content, "current thoughts");
	assert.equal(payload.messages[2].reasoning_content, "old thoughts", "input must not be mutated");
});

test("strips every reasoning field variant and leaves unrelated payloads untouched", () => {
	const payload = {
		messages: [
			{ role: "user", content: "q1" },
			{ role: "assistant", content: "a", reasoning: "x", reasoning_text: "y" },
			{ role: "user", content: "q2" },
		],
	};
	const out = stripStaleReasoning(payload) as typeof payload;
	assert.deepEqual(out.messages[1], { role: "assistant", content: "a" });
	const clean = { messages: [{ role: "user", content: "only" }] };
	assert.equal(stripStaleReasoning(clean), clean);
	assert.equal(stripStaleReasoning(null), null);
	const other = { input: "responses-shaped" };
	assert.equal(stripStaleReasoning(other), other);
});

const capBody = readFileSync(new URL("../fixtures/free-prompt-cap-error.json", import.meta.url), "utf8");

function assistantError(errorMessage: string, provider = "orcarouter") {
	return {
		role: "assistant" as const,
		provider,
		model: "deepseek/deepseek-v4-flash-free",
		api: "openai-completions",
		content: [],
		stopReason: "error" as const,
		errorMessage,
		timestamp: 0,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	};
}

test("without normalization Pi neither compacts nor retries the real cap error", () => {
	const original = assistantError(`400: ${capBody}`);
	assert.equal(isContextOverflow(original as never, 88000), false);
	assert.equal(isRetryableAssistantError(original as never), false);
});

test("normalized cap error is a context overflow and not retryable in Pi", () => {
	const fixed = normalizeFreePromptCapError(assistantError(`400: ${capBody}`));
	assert.ok(fixed);
	assert.equal(isContextOverflow(fixed as never, 88000), true);
	assert.equal(isRetryableAssistantError(fixed as never), false);
});

test("leaves other errors, other providers and already-normalized messages alone", () => {
	assert.equal(normalizeFreePromptCapError(assistantError('429: {"error":{"metadata":{"reason":"err_free_rate"}}}')), undefined);
	assert.equal(normalizeFreePromptCapError(assistantError(`400: ${capBody}`, "openrouter")), undefined);
	const once = normalizeFreePromptCapError(assistantError(`400: ${capBody}`));
	assert.equal(normalizeFreePromptCapError(once as never), undefined);
	assert.equal(normalizeFreePromptCapError({ role: "user" } as never), undefined);
});
