/**
 * Free-tier safeguards (pure functions).
 *
 * 1. stripStaleReasoning: OrcaRouter's free-tier prompt cap counts replayed `reasoning_content`
 *    in full, while the models ignore reasoning from earlier turns (reported prompt tokens are
 *    unchanged by it; findings M4). Removing it from assistant messages before the latest user
 *    message changes nothing the model sees and stops invisible growth toward the cap. Reasoning
 *    inside the current turn (tool loops) is kept.
 * 2. normalizeFreePromptCapError: the cap rejection (`metadata.reason == "err_free_prompt_cap"`,
 *    HTTP 400, retryable:false) matches none of Pi's overflow patterns, so Pi neither compacts nor
 *    retries. Rewriting only this positively identified error to `context_length_exceeded` lets
 *    Pi compact and retry, as Pi's custom-provider guide recommends.
 */
import { PROVIDER_ID } from "./metadata.ts";

const REASONING_FIELDS = ["reasoning_content", "reasoning", "reasoning_text"] as const;

export function stripStaleReasoning(payload: unknown): unknown {
	if (!payload || typeof payload !== "object") return payload;
	const messages = (payload as { messages?: unknown }).messages;
	if (!Array.isArray(messages)) return payload;
	let lastUser = -1;
	for (let i = messages.length - 1; i >= 0; i--) {
		if ((messages[i] as { role?: unknown })?.role === "user") {
			lastUser = i;
			break;
		}
	}
	if (lastUser <= 0) return payload;
	let changed = false;
	const next = messages.map((message, index) => {
		if (index >= lastUser || !message || typeof message !== "object") return message;
		if ((message as { role?: unknown }).role !== "assistant") return message;
		if (!REASONING_FIELDS.some((field) => field in message)) return message;
		const copy: Record<string, unknown> = { ...(message as Record<string, unknown>) };
		for (const field of REASONING_FIELDS) delete copy[field];
		changed = true;
		return copy;
	});
	return changed ? { ...(payload as object), messages: next } : payload;
}

export const PROMPT_CAP_REASON = "err_free_prompt_cap";

interface MaybeAssistantError {
	role?: unknown;
	provider?: unknown;
	stopReason?: unknown;
	errorMessage?: unknown;
}

/** Returns a replacement message, or undefined when the message is not the free prompt-cap error. */
export function normalizeFreePromptCapError<T extends MaybeAssistantError>(message: T): T | undefined {
	if (message?.role !== "assistant" || message.provider !== PROVIDER_ID || message.stopReason !== "error") return undefined;
	if (typeof message.errorMessage !== "string" || !message.errorMessage.includes(PROMPT_CAP_REASON)) return undefined;
	if (message.errorMessage.startsWith("context_length_exceeded")) return undefined;
	return {
		...message,
		// Must match Pi's /context[_ ]length[_ ]exceeded/ and avoid its "rate limit" non-overflow pattern.
		errorMessage:
			`context_length_exceeded: OrcaRouter free-tier prompt cap (${PROMPT_CAP_REASON}). ` +
			"The request is larger than free models accept in a single call; compact the conversation " +
			"or use the paid base model.",
	};
}
