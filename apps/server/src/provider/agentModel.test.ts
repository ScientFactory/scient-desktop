import { expect, it } from "vite-plus/test";
import * as SharedAgentModel from "@t3tools/provider-core/server/agentModel";

import * as AppAgentModel from "./agentModel.ts";

it("preserves the app-owned import path as a provider-core compatibility facade", () => {
  expect(AppAgentModel.encodeAgentModelSlug).toBe(SharedAgentModel.encodeAgentModelSlug);
  expect(AppAgentModel.splitAgentModelSlug).toBe(SharedAgentModel.splitAgentModelSlug);
  expect(AppAgentModel.thinkingLevelCapabilities).toBe(SharedAgentModel.thinkingLevelCapabilities);
});
