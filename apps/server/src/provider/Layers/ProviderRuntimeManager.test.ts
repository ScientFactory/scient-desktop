import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer } from "effect";
import { describe, expect, it, vi } from "vitest";

const shellMocks = vi.hoisted(() => ({
  readWindowsPersistentEnvironmentAsync: vi.fn(
    async (): Promise<Partial<Record<string, string>>> => ({ ...process.env }),
  ),
}));

vi.mock("@synara/shared/shell", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@synara/shared/shell")>()),
  readWindowsPersistentEnvironmentAsync: shellMocks.readWindowsPersistentEnvironmentAsync,
}));

import { ServerConfig } from "../../config";
import { ProviderRuntimeManager } from "../Services/ProviderRuntimeManager";
import type { ProviderRuntimeCurrentRecord } from "../providerRuntimeTypes";
import {
  cancelAndAwaitProviderRuntimeOperations,
  canActivateManagedRuntimeVersion,
  findExecutableOnPath,
  makeProviderRuntimeOperationGate,
  ProviderRuntimeManagerLive,
  windowsKnownProviderExecutableCandidates,
} from "./ProviderRuntimeManager";

function sha256(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function resolveAntigravity(baseDir: string, configuredExecutable?: string) {
  const configLayer = ServerConfig.layerTest(baseDir, baseDir).pipe(
    Layer.provide(NodeServices.layer),
  );
  const layer = Layer.mergeAll(
    configLayer,
    ProviderRuntimeManagerLive.pipe(Layer.provide(configLayer)),
  ).pipe(Layer.provide(NodeServices.layer));
  return Effect.gen(function* () {
    const manager = yield* ProviderRuntimeManager;
    return yield* manager.resolve("antigravity", configuredExecutable);
  }).pipe(Effect.provide(layer), Effect.scoped);
}

function getProviderSnapshot(baseDir: string, provider: "codex" | "antigravity") {
  const configLayer = ServerConfig.layerTest(baseDir, baseDir).pipe(
    Layer.provide(NodeServices.layer),
  );
  const layer = Layer.mergeAll(
    configLayer,
    ProviderRuntimeManagerLive.pipe(Layer.provide(configLayer)),
  ).pipe(Layer.provide(NodeServices.layer));
  return Effect.gen(function* () {
    const manager = yield* ProviderRuntimeManager;
    return yield* manager.getSnapshot(provider);
  }).pipe(Effect.provide(layer), Effect.scoped);
}

describe("ProviderRuntimeManager managed integrity", () => {
  it("makes cancellation and activation mutually exclusive", () => {
    const cancelled = makeProviderRuntimeOperationGate();
    expect(cancelled.cancel()).toBe(true);
    expect(cancelled.signal.aborted).toBe(true);
    expect(cancelled.beginCommit()).toBe(false);

    const committing = makeProviderRuntimeOperationGate();
    expect(committing.beginCommit()).toBe(true);
    expect(committing.cancel()).toBe(false);
    expect(committing.signal.aborted).toBe(false);
  });

  it("waits for active runtime operations to finish during shutdown", async () => {
    const gate = makeProviderRuntimeOperationGate();
    let finishOperation: (() => void) | undefined;
    let operationFinished = false;
    const completion = new Promise<void>((resolve) => {
      finishOperation = () => {
        operationFinished = true;
        resolve();
      };
    });

    const shutdown = cancelAndAwaitProviderRuntimeOperations([{ gate, completion }]);
    expect(gate.signal.aborted).toBe(true);
    expect(operationFinished).toBe(false);
    finishOperation?.();
    await shutdown;
    expect(operationFinished).toBe(true);
  });

  it("allows install or repair at the current version but never downgrades", () => {
    expect(
      canActivateManagedRuntimeVersion({ currentVersion: null, candidateVersion: "1.1.5" }),
    ).toBe(true);
    expect(
      canActivateManagedRuntimeVersion({ currentVersion: "1.1.4", candidateVersion: "1.1.5" }),
    ).toBe(true);
    expect(
      canActivateManagedRuntimeVersion({ currentVersion: "1.1.5", candidateVersion: "1.1.5" }),
    ).toBe(true);
    expect(
      canActivateManagedRuntimeVersion({ currentVersion: "1.1.5", candidateVersion: "1.1.4" }),
    ).toBe(false);
  });

  it("preserves an invalid custom executable as an explicit configuration error", async () => {
    const baseDir = mkdtempSync(path.join(os.tmpdir(), "scient-runtime-custom-"));
    try {
      const configuredExecutable = path.join(baseDir, "missing", "agy");
      const resolved = await Effect.runPromise(resolveAntigravity(baseDir, configuredExecutable));

      expect(resolved).toMatchObject({
        source: "custom",
        executable: null,
        canInstall: false,
      });
      expect(resolved.message).toContain(configuredExecutable);
      expect(resolved.message).toContain("Change or reset this custom path");
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("loads the last terminal installation failure after restart", async () => {
    const baseDir = mkdtempSync(path.join(os.tmpdir(), "scient-runtime-state-"));
    try {
      const stateDir = path.join(baseDir, "userdata", "provider-installations");
      mkdirSync(stateDir, { recursive: true });
      const failure = {
        operationId: "install-failed-1",
        operation: "install",
        status: "failed",
        startedAt: "2026-07-23T10:00:00.000Z",
        finishedAt: "2026-07-23T10:00:01.000Z",
        message: "Installation failed while downloading the provider: connection reset.",
      };
      writeFileSync(path.join(stateDir, "codex.json"), JSON.stringify(failure));

      const snapshot = await Effect.runPromise(getProviderSnapshot(baseDir, "codex"));
      expect(snapshot.installationState).toEqual(failure);
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("does not restore a stale successful installation after restart", async () => {
    const baseDir = mkdtempSync(path.join(os.tmpdir(), "scient-runtime-state-"));
    try {
      const stateDir = path.join(baseDir, "userdata", "provider-installations");
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(
        path.join(stateDir, "codex.json"),
        JSON.stringify({
          operationId: "install-succeeded-1",
          operation: "install",
          status: "installed",
          startedAt: "2026-07-23T10:00:00.000Z",
          finishedAt: "2026-07-23T10:00:01.000Z",
          message: "Codex is installed and verified.",
        }),
      );

      const snapshot = await Effect.runPromise(getProviderSnapshot(baseDir, "codex"));
      expect(snapshot.installationState).toBeNull();
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("recognizes the official standalone Codex install location on Windows", () => {
    expect(
      windowsKnownProviderExecutableCandidates({
        provider: "codex",
        environment: { LOCALAPPDATA: "C:\\Users\\Levin\\AppData\\Local" },
      }),
    ).toEqual(["C:\\Users\\Levin\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe"]);
    expect(
      windowsKnownProviderExecutableCandidates({
        provider: "antigravity",
        environment: { LOCALAPPDATA: "C:\\Users\\Levin\\AppData\\Local" },
      }),
    ).toEqual([]);
  });

  it.runIf(process.platform === "win32")(
    "finds a provider installed into a newly persisted Windows PATH entry",
    async () => {
      const baseDir = mkdtempSync(path.join(os.tmpdir(), "scient-windows-path-"));
      try {
        const executable = path.join(baseDir, "codex.exe");
        writeFileSync(executable, "test");
        const discovered = await findExecutableOnPath({
          command: "codex",
          pathValue: baseDir,
          platform: "win32",
        });
        expect(discovered).not.toBeNull();
        expect(readFileSync(discovered!, "utf8")).toBe("test");
      } finally {
        rmSync(baseDir, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform === "win32")(
    "refreshes the manager's persisted Windows PATH after an external provider install",
    async () => {
      const baseDir = mkdtempSync(path.join(os.tmpdir(), "scient-windows-manager-path-"));
      const previousPath = process.env.PATH;
      const emptyPath = path.join(baseDir, "empty");
      let persistedPath = emptyPath;
      let now = 1_000_000;
      const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
      shellMocks.readWindowsPersistentEnvironmentAsync.mockClear();
      shellMocks.readWindowsPersistentEnvironmentAsync.mockImplementation(async () => ({
        PATH: persistedPath,
      }));
      try {
        mkdirSync(emptyPath);
        writeFileSync(path.join(baseDir, "codex.exe"), "test");
        process.env.PATH = emptyPath;
        const configLayer = ServerConfig.layerTest(baseDir, baseDir).pipe(
          Layer.provide(NodeServices.layer),
        );
        const runtimeLayer = ProviderRuntimeManagerLive.pipe(Layer.provide(configLayer));
        const layer = Layer.mergeAll(configLayer, runtimeLayer).pipe(
          Layer.provide(NodeServices.layer),
        );

        const result = await Effect.runPromise(
          Effect.gen(function* () {
            const manager = yield* ProviderRuntimeManager;
            const beforeInstall = yield* manager.resolve("codex");
            persistedPath = baseDir;
            now += 5_001;
            const afterInstall = yield* manager.resolve("codex");
            return { beforeInstall, afterInstall };
          }).pipe(Effect.provide(layer), Effect.scoped),
        );

        expect(result.beforeInstall.source).toBe("missing");
        expect(result.afterInstall.source).toBe("system");
        expect(result.afterInstall.executable).not.toBeNull();
        expect(realpathSync.native(result.afterInstall.executable!)).toBe(
          realpathSync.native(path.join(baseDir, "codex.exe")),
        );
        expect(shellMocks.readWindowsPersistentEnvironmentAsync).toHaveBeenCalledTimes(2);
      } finally {
        nowSpy.mockRestore();
        shellMocks.readWindowsPersistentEnvironmentAsync.mockImplementation(
          async (): Promise<Partial<Record<string, string>>> => ({ ...process.env }),
        );
        if (previousPath === undefined) delete process.env.PATH;
        else process.env.PATH = previousPath;
        rmSync(baseDir, { recursive: true, force: true });
      }
    },
  );

  it("revalidates the executable after restart and rejects later corruption", async () => {
    const baseDir = mkdtempSync(path.join(os.tmpdir(), "scient-runtime-integrity-"));
    const previousPath = process.env.PATH;
    try {
      const stateDir = path.join(baseDir, "userdata");
      const releaseId = "test-release";
      const releaseDir = path.join(
        stateDir,
        "provider-runtimes",
        "antigravity",
        "releases",
        releaseId,
      );
      const executableRelativePath = path.join(
        "bin",
        process.platform === "win32" ? "agy.cmd" : "agy",
      );
      const executablePath = path.join(releaseDir, executableRelativePath);
      mkdirSync(path.dirname(executablePath), { recursive: true });
      writeFileSync(
        executablePath,
        process.platform === "win32"
          ? "@echo off\r\necho Antigravity CLI 1.1.4\r\n"
          : "#!/bin/sh\necho 'Antigravity CLI 1.1.4'\n",
      );
      chmodSync(executablePath, 0o700);
      const record: ProviderRuntimeCurrentRecord = {
        version: 1,
        provider: "antigravity",
        releaseId,
        previousReleaseId: null,
        runtimeVersion: "1.1.4",
        executableRelativePath,
        executablePath,
        smokeArgs: ["--version"],
        digestAlgorithm: "sha256",
        digest: "0".repeat(64),
        executableDigest: sha256(executablePath),
        sourceUrl: "https://example.invalid/agy",
        catalogRevision: "test",
        installedAt: new Date().toISOString(),
      };
      writeFileSync(path.join(releaseDir, "release.json"), JSON.stringify(record));
      mkdirSync(path.join(stateDir, "provider-runtimes", "antigravity"), { recursive: true });
      writeFileSync(
        path.join(stateDir, "provider-runtimes", "antigravity", "current.json"),
        JSON.stringify(record),
      );
      const emptyPath = path.join(baseDir, "empty-path");
      mkdirSync(emptyPath);
      process.env.PATH = emptyPath;

      const first = await Effect.runPromise(resolveAntigravity(baseDir));
      expect(first.source).toBe("managed");
      expect(first.executable).toBe(executablePath);

      writeFileSync(
        executablePath,
        process.platform === "win32"
          ? "@echo off\r\necho tampered\r\n"
          : "#!/bin/sh\necho 'tampered'\n",
      );
      chmodSync(executablePath, 0o700);
      const afterRestart = await Effect.runPromise(resolveAntigravity(baseDir));
      expect(afterRestart.source).toBe("missing");
      expect(afterRestart.executable).toBeNull();
      expect(afterRestart.canRepair).toBe(true);
      expect(
        JSON.parse(
          readFileSync(
            path.join(baseDir, "userdata", "provider-installations", "antigravity.json"),
            "utf8",
          ),
        ),
      ).toMatchObject({
        operation: "repair",
        status: "failed",
        message: expect.stringContaining("damaged and must be repaired"),
      });
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      rmSync(baseDir, { recursive: true, force: true });
    }
  });
});
