import {
  buildRuntimeInstructions,
  type RuntimeInstructionsInput,
} from "@t3tools/provider-core/server/runtimeInstructions";

import { SCIENT_PRODUCT_NAME } from "./ScientAgentCopy.ts";

/**
 * Shared runtime context; omit model and effort when the harness manages them dynamically.
 * `modelName` is the display name users see in the model picker; `model` is the slug.
 */
export function buildScientRuntimeInstructions(runtime: RuntimeInstructionsInput): string {
  return buildRuntimeInstructions({ ...runtime, productName: SCIENT_PRODUCT_NAME });
}
