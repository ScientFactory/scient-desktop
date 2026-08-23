import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { getProviderSummary } from "./providerStatus";

describe("getProviderSummary", () => {
  it("does not expose executable-path diagnostics in a missing-provider row", () => {
    const provider: ServerProvider = {
      instanceId: ProviderInstanceId.make("antigravity"),
      driver: ProviderDriverKind.make("antigravity"),
      enabled: true,
      installed: false,
      version: null,
      status: "error",
      auth: { status: "unknown", required: true },
      checkedAt: "2026-08-22T12:00:00.000Z",
      models: [],
      slashCommands: [],
      skills: [],
      message: "Antigravity CLI command `/private/provider-runtimes/antigravity` was not found.",
    };

    expect(getProviderSummary(provider)).toEqual({
      headline: "Not found",
      detail: null,
    });
  });
});
