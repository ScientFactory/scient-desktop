// @effect-diagnostics nodeBuiltinImport:off -- Tests exercise the managed Codex companion-file boundary.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { it as effectIt } from "@effect/vitest";
import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";

import type { ManagedRuntimeArtifact } from "@scientfactory/provider-runtime";
import {
  hasManagedCodexCodeModeHost,
  resolveCodexCodeModeHostPath,
  resolveCodexManagedRuntimePolicy,
  resolveCodexRuntimeHomePath,
  resolveCodexRuntimeSource,
  shouldProbeManagedCodexRuntime,
  shouldSkipConfiguredCodexProbe,
} from "./CodexManagedRuntimeActions.ts";

const artifact = {
  version: "2.0.0",
  supportTier: "fully_assisted",
} as ManagedRuntimeArtifact;

describe("Codex managed runtime policy", () => {
  effectIt.effect("requires a real executable code-mode host beside a managed Codex binary", () =>
    Effect.gen(function* () {
      const root = yield* Effect.tryPromise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-codex-health-")),
      );
      const binary = NodePath.join(root, "bin/codex");
      const host = NodePath.join(root, "bin/codex-code-mode-host");
      try {
        yield* Effect.tryPromise(() =>
          NodeFSP.mkdir(NodePath.dirname(binary), { recursive: true }),
        );
        yield* Effect.tryPromise(() => NodeFSP.writeFile(binary, "codex", { mode: 0o755 }));
        expect(yield* hasManagedCodexCodeModeHost(binary, "darwin")).toBe(false);

        yield* Effect.tryPromise(() => NodeFSP.writeFile(host, "host", { mode: 0o600 }));
        expect(yield* hasManagedCodexCodeModeHost(binary, "darwin")).toBe(false);

        yield* Effect.tryPromise(() => NodeFSP.chmod(host, 0o755));
        expect(yield* hasManagedCodexCodeModeHost(binary, "darwin")).toBe(true);

        yield* Effect.tryPromise(() => NodeFSP.rm(host));
        yield* Effect.tryPromise(() => NodeFSP.symlink(binary, host));
        expect(yield* hasManagedCodexCodeModeHost(binary, "darwin")).toBe(false);
        expect(resolveCodexCodeModeHostPath("C:\\Codex\\bin\\codex.exe", "win32")).toBe(
          "C:\\Codex\\bin\\codex-code-mode-host.exe",
        );
      } finally {
        yield* Effect.promise(() => NodeFSP.rm(root, { recursive: true, force: true }));
      }
    }),
  );

  it("preserves a configured custom runtime without taking ownership of it", () => {
    expect(
      resolveCodexRuntimeSource({
        hasCustomRuntime: true,
        configuredRuntimeHealthy: false,
        managedInstalled: true,
        managedRuntimeHealthy: true,
      }),
    ).toBe("unknown");
    expect(
      resolveCodexRuntimeSource({
        hasCustomRuntime: true,
        configuredRuntimeHealthy: true,
        managedInstalled: true,
        managedRuntimeHealthy: true,
      }),
    ).toBe("custom");
  });

  it("keeps an installed healthy managed runtime stable when PATH Codex is also healthy", () => {
    expect(
      resolveCodexRuntimeSource({
        hasCustomRuntime: false,
        configuredRuntimeHealthy: true,
        managedInstalled: true,
        managedRuntimeHealthy: true,
      }),
    ).toBe("scient_managed");
  });

  it("falls back from an unhealthy managed copy only to a capability-proven PATH runtime", () => {
    expect(
      resolveCodexRuntimeSource({
        hasCustomRuntime: false,
        configuredRuntimeHealthy: true,
        managedInstalled: true,
        managedRuntimeHealthy: false,
      }),
    ).toBe("system");
    expect(
      resolveCodexRuntimeSource({
        hasCustomRuntime: false,
        configuredRuntimeHealthy: false,
        managedInstalled: true,
        managedRuntimeHealthy: false,
      }),
    ).toBe("scient_managed");
  });

  it("uses a healthy PATH runtime when no private runtime is installed", () => {
    expect(
      resolveCodexRuntimeSource({
        hasCustomRuntime: false,
        configuredRuntimeHealthy: true,
        managedInstalled: false,
        managedRuntimeHealthy: false,
      }),
    ).toBe("system");
  });

  it("probes only runtimes that can participate in selection", () => {
    expect(
      shouldProbeManagedCodexRuntime({
        hasCustomRuntime: false,
        managedInstalled: true,
      }),
    ).toBe(true);
    expect(
      shouldProbeManagedCodexRuntime({
        hasCustomRuntime: true,
        managedInstalled: true,
      }),
    ).toBe(false);
    expect(
      shouldSkipConfiguredCodexProbe({
        hasCustomRuntime: false,
        managedRuntimeHealthy: true,
      }),
    ).toBe(true);
    expect(
      shouldSkipConfiguredCodexProbe({
        hasCustomRuntime: false,
        managedRuntimeHealthy: false,
      }),
    ).toBe(false);
    expect(
      shouldSkipConfiguredCodexProbe({
        hasCustomRuntime: true,
        managedRuntimeHealthy: true,
      }),
    ).toBe(false);
  });

  it("uses the exact effective Codex home for probes and diagnostics", () => {
    expect(
      resolveCodexRuntimeHomePath({
        effectiveHomePath: "  /private/scient/codex-shadow  ",
        configuredHomePath: "/shared/codex-home",
      }),
    ).toBe("/private/scient/codex-shadow");
    expect(
      resolveCodexRuntimeHomePath({
        effectiveHomePath: undefined,
        configuredHomePath: "  /shared/codex-home  ",
      }),
    ).toBe("/shared/codex-home");
  });

  it("offers installation for a reviewed local-desktop target", () => {
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

  it("offers managed installation beside a healthy system runtime", () => {
    expect(
      resolveCodexManagedRuntimePolicy({
        source: "system",
        artifact,
        installed: false,
        installedVersion: null,
        managedInstallationAllowed: true,
      }),
    ).toEqual({
      supportTier: "fully_assisted",
      actions: ["install"],
      useManagedPath: false,
    });
  });

  it("keeps a broken private copy repairable while using healthy PATH Codex", () => {
    expect(
      resolveCodexManagedRuntimePolicy({
        source: "system",
        artifact,
        installed: true,
        installedVersion: "2.0.0",
        managedInstallationAllowed: true,
      }).actions,
    ).toEqual(["repair", "remove"]);
  });

  it("does not advertise managed mutation outside the local desktop", () => {
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
