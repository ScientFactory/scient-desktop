import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import {
  createProviderVersionAdvisory,
  ProviderVersionCache,
  resolveProviderMaintenanceCapabilitiesEffect,
  type ProviderMaintenanceResolutionContext,
} from "../providerMaintenance.ts";
import {
  registerOmpProcess,
  resetOmpProcessRegistry,
  unregisterOmpProcess,
  isOmpBinaryUpdating,
} from "./OmpProcessRegistry.ts";
import {
  isOmpManagedRuntimePath,
  isOmpNativeUpdatePath,
  OMP_EXTERNAL_UPDATE_MESSAGE,
  OMP_LATEST_RELEASE_URL,
  OMP_NATIVE_UPDATE_LOCK_KEY,
  OMP_NATIVE_UPDATE_MESSAGE,
  ompMaintenance,
  parseOmpReleaseVersion,
  shapeOmpExternalAdvisory,
  withOmpReleaseVersion,
} from "./OmpMaintenance.ts";

const context = (path: string): ProviderMaintenanceResolutionContext => ({
  binaryPath: path,
  resolvedCommandPath: path,
  realCommandPath: path,
  env: { HOME: "/home/test", PATH: "" },
  platform: "linux",
});

it.effect("parses Oh My Pi release tags", () =>
  Effect.sync(() => {
    expect(parseOmpReleaseVersion("v18.2.8")).toBe("18.2.8");
    expect(parseOmpReleaseVersion('{"tag_name":"v18.3.0"}')).toBe("18.3.0");
    expect(parseOmpReleaseVersion('{"tag_name":"nightly"}')).toBeNull();
    expect(parseOmpReleaseVersion("18.3.0-beta.1")).toBeNull();
  }),
);

it.effect("notices a same-major release without offering a command by default", () =>
  Effect.sync(() => {
    const advisory = shapeOmpExternalAdvisory({
      currentVersion: "18.2.8",
      latestVersion: "18.3.0",
    });
    expect(advisory.status).toBe("behind_latest");
    expect(advisory.canUpdate).toBe(false);
    expect(advisory.updateCommand).toBeNull();
    expect(advisory.message).toBe(OMP_EXTERNAL_UPDATE_MESSAGE);
    expect(
      shapeOmpExternalAdvisory({ currentVersion: "18.2.8", latestVersion: "19.0.0" }).status,
    ).toBe("unknown");
    expect(
      shapeOmpExternalAdvisory({ currentVersion: "18.3.0-beta.1", latestVersion: "18.3.0" }).status,
    ).toBe("unknown");
  }),
);

it.layer(NodeServices.layer)("Oh My Pi update discovery", (it) => {
  it.effect("resolves the real OMP executable's native update command when requested", () =>
    Effect.gen(function* () {
      const binary = process.env.OMP_QUALIFY_BINARY;
      if (!binary) return;
      const capabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(ompMaintenance, {
        binaryPath: binary,
        env: process.env,
      });
      expect(capabilities.update?.args).toEqual(["update", "--stable"]);
      expect(capabilities.update?.lockKey).toBe(OMP_NATIVE_UPDATE_LOCK_KEY);
    }),
  );

  it.effect("uses OMP's native updater for official command paths", () =>
    Effect.gen(function* () {
      const bun = yield* ompMaintenance.resolve(context("/home/test/.bun/bin/omp"));
      const npm = yield* ompMaintenance.resolve(
        context("/opt/omp/lib/node_modules/@oh-my-pi/pi-coding-agent/bin/omp"),
      );
      expect(isOmpNativeUpdatePath("/home/test/.bun/bin/omp")).toBe(true);
      expect(isOmpNativeUpdatePath("/home/test/.bun/bin/omp.cmd")).toBe(true);
      expect(isOmpNativeUpdatePath("/home/test/.bun/bin/not-omp")).toBe(false);
      for (const capabilities of [bun, npm]) {
        expect(capabilities.packageName).toBeNull();
        const update = capabilities.update;
        expect(update).toBeDefined();
        if (!update) throw new Error("Expected native OMP update capability.");
        expect(update.executable).toMatch(/[/\\]omp$/u);
        expect(update.args).toEqual(["update", "--stable"]);
        expect(update.lockKey).toBe(OMP_NATIVE_UPDATE_LOCK_KEY);
        const commandDirectory = update.executable.slice(0, update.executable.lastIndexOf("/"));
        expect(update.env?.PATH?.startsWith(commandDirectory)).toBe(true);
      }
    }),
  );

  it.effect("refuses a native update while any OMP process for that executable is alive", () =>
    Effect.gen(function* () {
      const capabilities = yield* ompMaintenance.resolve(context("/usr/local/bin/omp"));
      const update = capabilities.update;
      if (!update?.canUpdate) throw new Error("Expected native OMP update capability.");
      expect(yield* update.canUpdate()).toBe(true);

      // An idle session, a one-shot title/commit run, and any other OMP
      // instance in this server all hold the same executable.
      registerOmpProcess({
        command: "/usr/local/bin/omp",
        id: "session-1",
        kind: "session",
        threadId: "thread-1",
      });
      expect(yield* update.canUpdate()).toBe(false);
      unregisterOmpProcess({ command: "/usr/local/bin/omp", id: "session-1" });

      // A different executable is unaffected.
      registerOmpProcess({
        command: "/opt/other/omp",
        id: "session-2",
        kind: "session",
        threadId: "thread-2",
      });
      expect(yield* update.canUpdate()).toBe(true);
      unregisterOmpProcess({ command: "/opt/other/omp", id: "session-2" });
    }).pipe(Effect.ensuring(Effect.sync(resetOmpProcessRegistry))),
  );

  it.effect("holds the executable exclusively while the updater runs", () =>
    Effect.gen(function* () {
      const capabilities = yield* ompMaintenance.resolve(context("/usr/local/bin/omp"));
      const update = capabilities.update;
      if (!update?.beforeRun || !update.afterRun) {
        throw new Error("Expected native OMP update bracket.");
      }
      expect(isOmpBinaryUpdating("/usr/local/bin/omp")).toBe(false);
      const during = yield* Effect.scoped(
        Effect.acquireUseRelease(
          update.beforeRun(),
          () => Effect.sync(() => isOmpBinaryUpdating("/usr/local/bin/omp")),
          () => update.afterRun?.() ?? Effect.void,
        ),
      );
      expect(during).toBe(true);
      expect(isOmpBinaryUpdating("/usr/local/bin/omp")).toBe(false);
    }).pipe(Effect.ensuring(Effect.sync(resetOmpProcessRegistry))),
  );

  it.effect("leaves an unknown path and a missing install without an update command", () =>
    Effect.gen(function* () {
      const binary = yield* ompMaintenance.resolve(context("/usr/local/bin/not-omp"));
      const managed = yield* ompMaintenance.resolve(
        context("/home/test/.scient-next/provider-runtimes/omp/versions/18.2.8/darwin-arm64/omp"),
      );
      const missing = yield* ompMaintenance.resolve(null);
      expect(
        isOmpManagedRuntimePath(
          "/home/test/.scient-next/provider-runtimes/omp/versions/18.2.8/omp",
        ),
      ).toBe(true);
      expect(managed.update).toBeNull();
      expect(managed.packageName).toBeNull();
      expect(binary.update).toBeNull();
      expect(binary.packageName).toBeNull();
      expect(missing.update).toBeNull();
      expect(missing.packageName).toBeNull();
    }),
  );

  it.effect("keeps the native command in the update advisory", () =>
    Effect.gen(function* () {
      const capabilities = yield* ompMaintenance.resolve(context("/usr/local/bin/omp"));
      const advisory = shapeOmpExternalAdvisory({
        currentVersion: "18.2.8",
        latestVersion: "18.3.0",
        maintenanceCapabilities: capabilities,
      });
      expect(advisory.status).toBe("behind_latest");
      expect(advisory.canUpdate).toBe(true);
      expect(advisory.updateCommand).toBe("/usr/local/bin/omp update --stable");
      expect(advisory.message).toBe(OMP_NATIVE_UPDATE_MESSAGE);
    }),
  );

  it.effect("reads the GitHub release while retaining the native command", () =>
    Effect.gen(function* () {
      const binary = yield* ompMaintenance.resolve(context("/usr/local/bin/omp"));
      let requests = 0;
      const client = HttpClient.make((request) => {
        requests += 1;
        expect(request.url).toBe(OMP_LATEST_RELEASE_URL);
        return Effect.succeed(
          HttpClientResponse.fromWeb(request, new Response('{"tag_name":"v18.3.1"}\n')),
        );
      });
      yield* Effect.gen(function* () {
        expect((yield* withOmpReleaseVersion(binary, false)).latestVersion).toBeUndefined();
        expect(requests).toBe(0);
        const discovered = yield* withOmpReleaseVersion(binary, true);
        expect(discovered.latestVersion).toBe("18.3.1");
        expect(discovered.update?.args).toEqual(["update", "--stable"]);
        expect(
          createProviderVersionAdvisory({
            driver: discovered.provider,
            currentVersion: "18.2.8",
            latestVersion: discovered.latestVersion ?? null,
            maintenanceCapabilities: discovered,
          }).status,
        ).toBe("behind_latest");
        expect((yield* withOmpReleaseVersion(binary, true)).latestVersion).toBe("18.3.1");
        expect(requests).toBe(1);
      }).pipe(
        Effect.provideService(HttpClient.HttpClient, client),
        Effect.provideService(ProviderVersionCache, new Map()),
      );
    }),
  );
});
