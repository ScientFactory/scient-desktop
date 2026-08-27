import { createEnvironmentRpcQueryAtomFamily } from "@t3tools/client-runtime/state/runtime";
import { WS_METHODS } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";

export const scientSkillsInventory = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "mobile-environment-data:skills:list",
  tag: WS_METHODS.skillsList,
  staleTimeMs: 30_000,
  idleTtlMs: 60_000,
});
