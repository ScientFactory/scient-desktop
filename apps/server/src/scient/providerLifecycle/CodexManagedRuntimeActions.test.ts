import { describe, expect, it } from "vite-plus/test";

import type { ManagedRuntimeArtifact } from "@scientfactory/provider-runtime";
import { resolveCodexManagedRuntimePolicy } from "./CodexManagedRuntimeActions.ts";

const artifact = {
  supportTier: "fully_assisted",
} as ManagedRuntimeArtifact;

describe("Codex managed runtime policy", () => {
  it("offers installation only for the proven local-desktop target", () => {
    expect(
      resolveCodexManagedRuntimePolicy({
        source: "missing",
        artifact,
        installed: false,
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
        managedInstallationAllowed: true,
      }).actions,
    ).toEqual(["repair", "remove"]);
    expect(
      resolveCodexManagedRuntimePolicy({
        source: "system",
        artifact,
        installed: false,
        managedInstallationAllowed: true,
      }).actions,
    ).toEqual([]);
    expect(
      resolveCodexManagedRuntimePolicy({
        source: "custom",
        artifact,
        installed: false,
        managedInstallationAllowed: true,
      }).actions,
    ).toEqual([]);
  });
});
