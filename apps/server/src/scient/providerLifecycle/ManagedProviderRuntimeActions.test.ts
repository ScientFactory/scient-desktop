import { describe, expect, it } from "vite-plus/test";

import {
  ManagedProviderRuntimeError,
  ManagedRuntimeFileError,
} from "@scientfactory/provider-runtime";

import {
  managedRuntimeInstallationFailureMessage,
  resolveManagedRuntimeSource,
} from "./ManagedProviderRuntimeActions.ts";

describe("managed provider runtime source", () => {
  it("reports an unhealthy custom runtime honestly without replacing it", () => {
    expect(
      resolveManagedRuntimeSource({
        hasCustomRuntime: true,
        configuredRuntimeHealthy: false,
        managedInstalled: true,
      }),
    ).toBe("unknown");
  });

  it("distinguishes healthy configured, managed, and missing runtimes", () => {
    expect(
      resolveManagedRuntimeSource({
        hasCustomRuntime: true,
        configuredRuntimeHealthy: true,
        managedInstalled: false,
      }),
    ).toBe("custom");
    expect(
      resolveManagedRuntimeSource({
        hasCustomRuntime: false,
        configuredRuntimeHealthy: false,
        managedInstalled: true,
      }),
    ).toBe("scient_managed");
    expect(
      resolveManagedRuntimeSource({
        hasCustomRuntime: false,
        configuredRuntimeHealthy: false,
        managedInstalled: false,
      }),
    ).toBe("missing");
  });
});

describe("managed provider runtime installation failures", () => {
  it("preserves safe download and verification details for recovery", () => {
    expect(
      managedRuntimeInstallationFailureMessage(
        "Claude",
        new ManagedRuntimeFileError("Managed runtime download failed with HTTP 404."),
      ),
    ).toBe(
      "Scient could not install the private Claude runtime. Managed runtime download failed with HTTP 404.",
    );
    expect(
      managedRuntimeInstallationFailureMessage(
        "Claude",
        new ManagedProviderRuntimeError("Managed Claude smoke test failed with code 1."),
      ),
    ).toContain("Managed Claude smoke test failed with code 1.");
  });

  it("does not expose unknown failure details", () => {
    expect(
      managedRuntimeInstallationFailureMessage(
        "Claude",
        new Error("secret-bearing implementation detail"),
      ),
    ).toBe("Scient could not install the private Claude runtime.");
  });
});
