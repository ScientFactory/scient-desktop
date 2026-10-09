import type { AcpAdapterV2ApplicationBridge } from "@t3tools/provider-acp/server/adapter";

import { toMcpCapabilities } from "../../mcp/McpInvocationContext.ts";
import { buildScientAwareness } from "../../provider/ScientAwareness.ts";
import {
  isPreAcceptanceRejectionCode,
  nativeTurnAcceptance,
} from "../scient-provider/NativeTurnReceipts.ts";

/** Scient-owned native delivery observations shared by ACP flavors. */
export const scientAcpReceiptBridge = {
  nativeTurnAcceptance,
  isPreAcceptanceRejectionCode,
} satisfies Pick<
  AcpAdapterV2ApplicationBridge,
  "nativeTurnAcceptance" | "isPreAcceptanceRejectionCode"
>;

/**
 * Adds awareness only for flavors whose native launcher has a real prompt or
 * rules seam. Callers without one use `scientAcpReceiptBridge` instead.
 */
export const scientAcpAwarenessBridge = {
  scientAwareness: (capabilities) =>
    buildScientAwareness(capabilities === undefined ? undefined : toMcpCapabilities(capabilities)),
} satisfies Pick<AcpAdapterV2ApplicationBridge, "scientAwareness">;

/** Full bridge for ACP flavors that can deliver a Scient prompt. */
export const scientAcpApplicationBridge = {
  ...scientAcpReceiptBridge,
  ...scientAcpAwarenessBridge,
} satisfies AcpAdapterV2ApplicationBridge;
