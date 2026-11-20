import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { getProviderSummary } from "./providerStatus";

describe("getProviderSummary (Scient)", () => {
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

  it("names a custom Claude endpoint and where it was set", () => {
    const claude = (endpointSource?: "claude-settings" | "environment"): ServerProvider => ({
      instanceId: ProviderInstanceId.make("claudeAgent"),
      driver: ProviderDriverKind.make("claudeAgent"),
      enabled: true,
      installed: true,
      version: "2.1.302",
      status: "ready",
      auth: {
        status: "authenticated",
        type: "customEndpoint",
        label: "Custom API endpoint",
        endpoint: "http://127.0.0.1:3456",
        ...(endpointSource ? { endpointSource } : {}),
      },
      checkedAt: "2026-11-20T00:00:00.000Z",
      models: [],
      slashCommands: [],
      skills: [],
    });

    expect(getProviderSummary(claude("claude-settings"))).toEqual({
      headline: "Authenticated · Custom API endpoint",
      detail:
        "Sends requests to http://127.0.0.1:3456. Set by ANTHROPIC_BASE_URL in Claude's settings.",
    });
    expect(getProviderSummary(claude("environment")).detail).toBe(
      "Sends requests to http://127.0.0.1:3456. Set by the ANTHROPIC_BASE_URL environment variable, in this provider's settings or on this computer.",
    );
    expect(getProviderSummary(claude()).detail).toBe("Sends requests to http://127.0.0.1:3456.");
  });
});
