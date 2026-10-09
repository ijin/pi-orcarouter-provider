import { envApiKeyAuth, type Model, type Provider, type RefreshModelsContext } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/compat";
import type { CatalogStore } from "./catalog.ts";
import { BASE_URL, buildModels, isFreeRoute, PROVIDER_ID } from "./metadata.ts";
import { stripStaleReasoning } from "./safeguards.ts";

type OrcaApi = "openai-completions";
type PayloadHook = (payload: unknown, model: Model<OrcaApi>) => unknown | undefined | Promise<unknown | undefined>;

/** Chain the caller's onPayload (extension request inspection) before the free-route safeguard. */
export function withFreeRouteSafeguard<T extends { onPayload?: PayloadHook } | undefined>(model: Model<OrcaApi>, options: T): T {
	if (!isFreeRoute(model.id)) return options;
	const upstream = options?.onPayload;
	return {
		...(options ?? {}),
		onPayload: async (payload: unknown, m: Model<OrcaApi>) => {
			const replaced = upstream ? await upstream(payload, m) : undefined;
			return stripStaleReasoning(replaced ?? payload);
		},
	} as T;
}

export function createOrcaRouterProvider(catalog: CatalogStore): Provider<OrcaApi> {
	const transport = openAICompletionsApi();
	let models: Model<OrcaApi>[] = buildModels(catalog.snapshot.raw);

	return {
		id: PROVIDER_ID,
		name: "OrcaRouter",
		baseUrl: BASE_URL,
		auth: { apiKey: envApiKeyAuth("OrcaRouter API key", ["ORCAROUTER_API_KEY"]) },
		getModels: () => models,
		async refreshModels(context: RefreshModelsContext) {
			// Install whatever the store currently holds (cache loaded at startup, or a refresh
			// completed elsewhere), then fetch only when allowed and needed.
			const current = buildModels(catalog.snapshot.raw);
			if (!(await context.publish({ update: () => void (models = current) }))) return;
			if (!context.allowNetwork || context.signal.aborted) return;
			if (!context.force && !catalog.isStale()) return;
			try {
				const snapshot = await catalog.refresh(context.signal);
				if (context.signal.aborted) return;
				const refreshed = buildModels(snapshot.raw);
				await context.publish({ update: () => void (models = refreshed) });
			} catch (error) {
				// Keep the previous catalog. Only explicit refreshes surface the failure.
				if (context.force) throw error;
			}
		},
		stream: (model, context, options) => transport.stream(model, context, withFreeRouteSafeguard(model, options)),
		streamSimple: (model, context, options) =>
			transport.streamSimple(model, context, withFreeRouteSafeguard(model, options)),
	};
}
