// FILE: providerUpdateRuntimePolicy.test.ts
// Purpose: Covers authoritative managed, external, and missing update routing.
// Layer: Provider runtime policy tests

import { describe, expect, it } from "vitest";

import type { ResolvedProviderRuntime } from "./Services/ProviderRuntimeManager";
import { providerExternalUpdateBlockReason } from "./providerUpdateRuntimePolicy";

function runtime(overrides: Partial<ResolvedProviderRuntime> = {}): ResolvedProviderRuntime {
  return {
    source: "system",
    executable: "/Users/test/.local/bin/agy",
    managedVersion: null,
    canInstall: false,
    canRepair: false,
    canRollback: false,
    canRemove: false,
    message: null,
    ...overrides,
  };
}

describe("providerExternalUpdateBlockReason", () => {
  it("allows only a resolved external executable", () => {
    expect(providerExternalUpdateBlockReason("antigravity", runtime())).toBeNull();
  });

  it("routes Scient-managed updates through the verified runtime lifecycle", () => {
    expect(
      providerExternalUpdateBlockReason(
        "antigravity",
        runtime({ source: "managed", managedVersion: "1.1.4" }),
      ),
    ).toContain("verified managed update flow");
  });

  it("rejects a missing executable with a plain setup instruction", () => {
    expect(
      providerExternalUpdateBlockReason(
        "antigravity",
        runtime({ source: "missing", executable: null, canInstall: true }),
      ),
    ).toBe("Antigravity is not installed. Use Set up to install it before updating.");
  });
});
