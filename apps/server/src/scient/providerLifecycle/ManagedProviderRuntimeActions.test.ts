import { describe, expect, it } from "vite-plus/test";

import {
  ManagedProviderRuntimeError,
  ManagedRuntimeFileError,
} from "@scientfactory/provider-runtime";

import {
  makeManagedProviderRuntimeDiagnostics,
  managedRuntimeInstallationFailureMessage,
  nativeProviderRuntimeBackendLabel,
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

describe("managed provider runtime diagnostics", () => {
  it("reports managed versions without inventing a version for external runtimes", () => {
    expect(
      makeManagedProviderRuntimeDiagnostics({
        executable: "/private/claude",
        source: "scient_managed",
        managedVersion: "2.1.241",
        homePath: "/private/claude-home",
        backend: "macOS native",
      }),
    ).toEqual({
      executable: "/private/claude",
      version: "2.1.241",
      homePath: "/private/claude-home",
      backend: "macOS native",
    });
    expect(
      makeManagedProviderRuntimeDiagnostics({
        executable: "/usr/local/bin/claude",
        source: "system",
        managedVersion: null,
        homePath: null,
        backend: "macOS native",
      }).version,
    ).toBeNull();
  });

  it("uses truthful platform-specific backend labels", () => {
    expect(nativeProviderRuntimeBackendLabel("darwin")).toBe("macOS native");
    expect(nativeProviderRuntimeBackendLabel("win32")).toBe("Windows native");
    expect(nativeProviderRuntimeBackendLabel("linux")).toBe("Linux native");
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
