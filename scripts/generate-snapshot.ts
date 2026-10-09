/** Regenerate src/snapshot.json from the public, anonymous OrcaRouter catalog endpoints. */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CACHE_FORMAT_VERSION, fetchRawCatalog } from "../src/catalog.ts";
import { buildModels, POLICY_VERSION } from "../src/metadata.ts";

const raw = await fetchRawCatalog(fetch as never);
const snapshot = { format: CACHE_FORMAT_VERSION, policyVersion: POLICY_VERSION, fetchedAt: Date.now(), raw };
writeFileSync(fileURLToPath(new URL("../src/snapshot.json", import.meta.url)), `${JSON.stringify(snapshot)}\n`);
console.log(`snapshot: ${raw.models.length} /v1/models entries, ${raw.pricing.length} pricing entries, ${buildModels(raw).length} chat models`);
