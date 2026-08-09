import { describe, expect, it } from "vite-plus/test";

import type { ManagedRuntimeArtifact } from "@scientfactory/provider-runtime";
import {
  resolveCodexManagedRuntimePolicy,
  resolveCodexRuntimeSource,
} from "./CodexManagedRuntimeActions.ts";

const artifact = {
  version: "2.0.0",
  supportTier: "fully_assisted",
} as ManagedRuntimeArtifact;

describe("Codex managed runtime policy", () => {
  it("reports an unhealthy custom runtime honestly without overriding the configured path", () => {
    expect(
      resolveCodexRuntimeSource({
        hasCustomRuntime: true,
        configuredRuntimeHealthy: false,
        managedInstalled: true,
      }),
    ).toBe("unknown");
    expect(
      resolveCodexRuntimeSource({
        hasCustomRuntime: true,
        configuredRuntimeHealthy: true,
        managedInstalled: false,
      }),
    ).toBe("custom");
  });

  it("offers installation only for the proven local-desktop target", () => {
    expect(
      resolveCodexManagedRuntimePolicy({
        source: "missing",
        artifact,
        installed: false,
        installedVersion: null,
        managedInstallationAllowed: true,
      }),
    ).toEqual({
      supportTier: "fully_assisted",
      actions: ["install"],
      useManagedPath: true,
    });
  });

  it("downgrades the same artifact honestly outside the local desktop", () => {
    expect(
      resolveCodexManagedRuntimePolicy({
        source: "missing",
        artifact,
        installed: false,
        installedVersion: null,
        managedInstallationAllowed: false,
      }),
    ).toEqual({
      supportTier: "external_runtime_supported",
      actions: [],
      useManagedPath: false,
    });
  });

  it("preserves an existing managed runtime without taking ownership of external runtimes", () => {
    expect(
      resolveCodexManagedRuntimePolicy({
        source: "scient_managed",
        artifact,
        installed: true,
        installedVersion: "2.0.0",
        managedInstallationAllowed: true,
      }).actions,
    ).toEqual(["repair", "remove"]);
    expect(
      resolveCodexManagedRuntimePolicy({
        source: "system",
        artifact,
        installed: false,
        installedVersion: null,
        managedInstallationAllowed: true,
      }).actions,
    ).toEqual([]);
    expect(
      resolveCodexManagedRuntimePolicy({
        source: "custom",
        artifact,
        installed: false,
        installedVersion: null,
        managedInstallationAllowed: true,
      }).actions,
    ).toEqual([]);
  });

  it("offers a verified update while preserving an older managed runtime", () => {
    expect(
      resolveCodexManagedRuntimePolicy({
        source: "scient_managed",
        artifact,
        installed: true,
        installedVersion: "1.0.0",
        managedInstallationAllowed: true,
      }).actions,
    ).toEqual(["update", "repair", "remove"]);
  });
});
