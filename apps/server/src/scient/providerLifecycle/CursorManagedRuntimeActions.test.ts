// @effect-diagnostics nodeBuiltinImport:off -- The test exercises local process discovery.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { CursorSettings } from "@t3tools/contracts";
import { afterEach, describe, expect } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import { makeCursorManagedRuntimeResolution } from "./CursorManagedRuntimeActions.ts";

const decodeCursorSettings = Schema.decodeSync(CursorSettings);
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});

describe("Cursor managed runtime discovery", () => {
  it.effect("uses authoritative instance enablement instead of the legacy config default", () =>
    Effect.gen(function* () {
      const baseDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-cursor-runtime-")),
      );
      temporaryRoots.push(baseDir);
      const settings = decodeCursorSettings({ binaryPath: process.execPath });
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

      expect(settings.enabled).toBe(false);
      const resolution = yield* makeCursorManagedRuntimeResolution({
        settings,
        enabled: true,
        baseDir,
        environment: process.env,
        spawner,
        managedInstallationAllowed: false,
      });

      expect(resolution.summary.source).toBe("custom");
      expect(resolution.effectiveBinaryPath).toBe(process.execPath);
      expect(resolution.usesManagedPath).toBe(false);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("does not probe configured runtimes while the instance is disabled", () =>
    Effect.gen(function* () {
      const baseDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-cursor-runtime-")),
      );
      temporaryRoots.push(baseDir);
      const settings = decodeCursorSettings({ binaryPath: process.execPath });
      const spawner = ChildProcessSpawner.make(() =>
        Effect.die("Disabled Cursor runtime discovery must not spawn the configured binary"),
      );

      const resolution = yield* makeCursorManagedRuntimeResolution({
        settings,
        enabled: false,
        baseDir,
        environment: process.env,
        spawner,
        managedInstallationAllowed: false,
      });

      expect(resolution.summary.source).toBe("unknown");
      expect(resolution.effectiveBinaryPath).toBe(process.execPath);
      expect(resolution.usesManagedPath).toBe(false);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
