// @effect-diagnostics nodeBuiltinImport:off -- lifecycle tests use isolated app-owned fixture roots.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { ComputeToolkitId, type ComputeManagedRuntimeStatus } from "@scientfactory/compute";
import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  type ManagedPythonEnvironmentDependencies,
  makeManagedPythonEnvironmentManager,
} from "./ManagedPythonEnvironment.ts";
import {
  MANAGED_PYTHON_PROVISIONER_VERSION,
  MANAGED_PYTHON_TOOLKIT_REVISION,
  MANAGED_PYTHON_VERSION,
} from "./ManagedPythonProvisioner.ts";
import { makeManagedPythonRuntimeController } from "./ManagedPythonRuntimeController.ts";

const TOOLKIT_ID = ComputeToolkitId.make("python-data-and-figures");
const OPTIONAL_TOOLKIT_ID = ComputeToolkitId.make("python-image-analysis");

describe("ManagedPythonRuntimeController", () => {
  let temporaryRoot: string;
  let computeDir: string;

  beforeEach(async () => {
    temporaryRoot = await NodeFSP.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "scient-python-controller-"),
    );
    computeDir = NodePath.join(temporaryRoot, "compute");
  });

  afterEach(async () => {
    await NodeFSP.rm(temporaryRoot, { recursive: true, force: true });
  });

  const executableAt = async (targetRoot: string) => {
    const executable = NodePath.join(targetRoot, "environment", "bin", "python");
    await NodeFSP.mkdir(NodePath.dirname(executable), { recursive: true });
    await NodeFSP.writeFile(executable, "python", { mode: 0o700 });
    return { executableRelativePath: NodePath.join("environment", "bin", "python") };
  };

  const dependencies = (
    overrides: Partial<ManagedPythonEnvironmentDependencies> = {},
  ): ManagedPythonEnvironmentDependencies => ({
    provision: async ({ targetRoot }) => await executableAt(targetRoot),
    verify: async () => undefined,
    ...overrides,
  });

  it.live("explains an in-use removal refusal without starting an operation", () =>
    Effect.gen(function* () {
      const manager = makeManagedPythonEnvironmentManager(computeDir, dependencies(), "python", {
        trackUsage: true,
      });
      const controller = makeManagedPythonRuntimeController({ manager, toolkitIds: [TOOLKIT_ID] });
      yield* controller.manage("install");
      yield* waitForSettled(controller);
      const installed = yield* Effect.promise(() => manager.inspect());
      const release = yield* Effect.promise(() => manager.acquire(installed!.executable));
      const refused = yield* controller.manage("remove").pipe(Effect.flip);
      expect(refused.message).toContain("Stop sessions using Scient-managed Python");
      expect((yield* controller.status()).operation).toBeNull();
      release();
      yield* Effect.promise(() => manager.collect());
      controller.dispose();
    }),
  );

  it.live("accepts independent requests while busy and coalesces their next generation", () =>
    Effect.gen(function* () {
      const second = ComputeToolkitId.make("python-large-data");
      const third = ComputeToolkitId.make("python-bioinformatics");
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const builds: ReadonlyArray<ComputeToolkitId>[] = [];
      const manager = makeManagedPythonEnvironmentManager(
        computeDir,
        dependencies({
          provision: async ({ targetRoot, toolkitIds }) => {
            builds.push(toolkitIds);
            if (builds.length === 2) await gate;
            return executableAt(targetRoot);
          },
        }),
      );
      const controller = makeManagedPythonRuntimeController({
        manager,
        toolkitIds: [TOOLKIT_ID, OPTIONAL_TOOLKIT_ID, second, third],
        requiredToolkitIds: [TOOLKIT_ID],
      });
      yield* controller.manage("install");
      yield* waitForSettled(controller);
      yield* controller.manage("update", {
        toolkitChange: { toolkitId: OPTIONAL_TOOLKIT_ID, action: "install" },
      });
      yield* waitForStatus(controller, () => builds.length === 2);
      yield* controller.manage("update", {
        toolkitChange: { toolkitId: second, action: "install" },
      });
      const queued = yield* controller.manage("update", {
        toolkitChange: { toolkitId: third, action: "install" },
      });
      expect(queued.toolkitChanges?.map((entry) => entry.state)).toEqual([
        "running",
        "queued",
        "queued",
      ]);
      expect(queued.toolkitIds).toEqual([TOOLKIT_ID]);
      // A duplicate request from another client must not create another build.
      yield* controller.manage("update", {
        toolkitChange: { toolkitId: second, action: "install" },
      });
      release();
      const settled = yield* waitForSettled(controller);
      expect(settled.toolkitIds).toEqual([TOOLKIT_ID, OPTIONAL_TOOLKIT_ID, second, third]);
      expect(settled.toolkitChanges).toEqual([]);
      expect(builds).toHaveLength(3);
      controller.dispose();
    }),
  );

  it.live("cancels queued requests without interrupting the running Toolkit", () =>
    Effect.gen(function* () {
      const second = ComputeToolkitId.make("python-large-data");
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let buildCount = 0;
      let buildSignal: AbortSignal | undefined;
      const manager = makeManagedPythonEnvironmentManager(
        computeDir,
        dependencies({
          provision: async ({ targetRoot, signal }) => {
            if (++buildCount === 2) {
              buildSignal = signal;
              await gate;
            }
            return executableAt(targetRoot);
          },
        }),
      );
      const controller = makeManagedPythonRuntimeController({
        manager,
        toolkitIds: [TOOLKIT_ID, OPTIONAL_TOOLKIT_ID, second],
        requiredToolkitIds: [TOOLKIT_ID],
      });
      yield* controller.manage("install");
      yield* waitForSettled(controller);
      yield* controller.manage("update", {
        toolkitChange: { toolkitId: OPTIONAL_TOOLKIT_ID, action: "install" },
      });
      yield* waitForStatus(controller, () => buildCount === 2);
      yield* controller.manage("update", {
        toolkitChange: { toolkitId: second, action: "install" },
      });
      yield* controller.manage("update", {
        toolkitChange: { toolkitId: second, action: "cancel" },
      });
      expect(buildSignal?.aborted).toBe(false);
      release();
      const settled = yield* waitForSettled(controller);
      expect(settled.toolkitIds).toEqual([TOOLKIT_ID, OPTIONAL_TOOLKIT_ID]);
      expect(buildCount).toBe(2);
      controller.dispose();
    }),
  );

  it.live(
    "cancels one member of a coalesced build and safely rebuilds the remaining requests",
    () =>
      Effect.gen(function* () {
        const second = ComputeToolkitId.make("python-large-data");
        const third = ComputeToolkitId.make("python-bioinformatics");
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        let buildCount = 0;
        const manager = makeManagedPythonEnvironmentManager(
          computeDir,
          dependencies({
            provision: async ({ targetRoot, signal }) => {
              const build = ++buildCount;
              if (build === 2) await gate;
              if (build === 3)
                await new Promise<void>((_resolve, reject) => {
                  if (signal.aborted) reject(new Error("aborted"));
                  else
                    signal.addEventListener("abort", () => reject(new Error("aborted")), {
                      once: true,
                    });
                });
              return executableAt(targetRoot);
            },
          }),
        );
        const controller = makeManagedPythonRuntimeController({
          manager,
          toolkitIds: [TOOLKIT_ID, OPTIONAL_TOOLKIT_ID, second, third],
          requiredToolkitIds: [TOOLKIT_ID],
        });
        yield* controller.manage("install");
        yield* waitForSettled(controller);
        yield* controller.manage("update", {
          toolkitChange: { toolkitId: OPTIONAL_TOOLKIT_ID, action: "install" },
        });
        yield* controller.manage("update", {
          toolkitChange: { toolkitId: second, action: "install" },
        });
        yield* controller.manage("update", {
          toolkitChange: { toolkitId: third, action: "install" },
        });
        release();
        yield* waitForStatus(controller, () => buildCount === 3);
        yield* controller.manage("update", {
          toolkitChange: { toolkitId: second, action: "cancel" },
        });
        const settled = yield* waitForSettled(controller);
        expect(settled.toolkitIds).toEqual([TOOLKIT_ID, OPTIONAL_TOOLKIT_ID, third]);
        expect(settled.toolkitChanges).toEqual([]);
        expect(buildCount).toBe(4);
        controller.dispose();
      }),
  );

  it.live("rejects unknown, required, and ambiguous Toolkit changes before provisioning", () =>
    Effect.gen(function* () {
      let builds = 0;
      const manager = makeManagedPythonEnvironmentManager(
        computeDir,
        dependencies({
          provision: async ({ targetRoot }) => {
            builds++;
            return executableAt(targetRoot);
          },
        }),
      );
      const controller = makeManagedPythonRuntimeController({
        manager,
        toolkitIds: [TOOLKIT_ID, OPTIONAL_TOOLKIT_ID],
        requiredToolkitIds: [TOOLKIT_ID],
      });
      for (const toolkitId of [TOOLKIT_ID, ComputeToolkitId.make("python-unknown")]) {
        const result = yield* controller
          .manage("update", { toolkitChange: { toolkitId, action: "install" } })
          .pipe(Effect.result);
        expect(result._tag).toBe("Failure");
      }
      const result = yield* controller
        .manage("update", {
          toolkitChange: { toolkitId: OPTIONAL_TOOLKIT_ID, action: "install" },
          toolkitIds: [TOOLKIT_ID],
        })
        .pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      expect(builds).toBe(0);
      controller.dispose();
    }),
  );

  it.live("isolates a failed Toolkit, drains unrelated requests, and rebases retry", () =>
    Effect.gen(function* () {
      const second = ComputeToolkitId.make("python-large-data");
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let buildCount = 0;
      const manager = makeManagedPythonEnvironmentManager(
        computeDir,
        dependencies({
          provision: async ({ targetRoot }) => {
            if (++buildCount === 2) {
              await gate;
              throw new Error("fixture download failed");
            }
            return executableAt(targetRoot);
          },
        }),
      );
      const controller = makeManagedPythonRuntimeController({
        manager,
        toolkitIds: [TOOLKIT_ID, OPTIONAL_TOOLKIT_ID, second],
        requiredToolkitIds: [TOOLKIT_ID],
      });
      yield* controller.manage("install");
      yield* waitForSettled(controller);
      yield* controller.manage("update", {
        toolkitChange: { toolkitId: OPTIONAL_TOOLKIT_ID, action: "install" },
      });
      yield* controller.manage("update", {
        toolkitChange: { toolkitId: second, action: "install" },
      });
      release();
      const failed = yield* waitForSettled(controller);
      expect(failed.toolkitIds).toEqual([TOOLKIT_ID, second]);
      expect(failed.toolkitChanges).toMatchObject([
        { toolkitId: OPTIONAL_TOOLKIT_ID, state: "failed", install: true },
      ]);
      expect(failed.failure).toBeNull();
      yield* controller.manage("update", {
        toolkitChange: { toolkitId: OPTIONAL_TOOLKIT_ID, action: "install" },
      });
      expect((yield* waitForSettled(controller)).toolkitIds).toEqual([
        TOOLKIT_ID,
        OPTIONAL_TOOLKIT_ID,
        second,
      ]);
      controller.dispose();
    }),
  );

  it.live.each(["cancel", "dispose"] as const)(
    "%s stops the active build and clears pending work",
    (action) =>
      Effect.gen(function* () {
        const second = ComputeToolkitId.make("python-large-data");
        let buildCount = 0;
        const manager = makeManagedPythonEnvironmentManager(
          computeDir,
          dependencies({
            provision: async ({ targetRoot, signal }) => {
              if (++buildCount === 2)
                await new Promise<void>((_resolve, reject) => {
                  if (signal.aborted) reject(new Error("aborted"));
                  else
                    signal.addEventListener("abort", () => reject(new Error("aborted")), {
                      once: true,
                    });
                });
              return executableAt(targetRoot);
            },
          }),
        );
        const controller = makeManagedPythonRuntimeController({
          manager,
          toolkitIds: [TOOLKIT_ID, OPTIONAL_TOOLKIT_ID, second],
          requiredToolkitIds: [TOOLKIT_ID],
        });
        yield* controller.manage("install");
        yield* waitForSettled(controller);
        yield* controller.manage("update", {
          toolkitChange: { toolkitId: OPTIONAL_TOOLKIT_ID, action: "install" },
        });
        yield* waitForStatus(controller, () => buildCount === 2);
        yield* controller.manage("update", {
          toolkitChange: { toolkitId: second, action: "install" },
        });
        if (action === "cancel") yield* controller.cancel();
        else controller.dispose();
        const settled = yield* waitForSettled(controller);
        expect(settled.toolkitIds).toEqual([TOOLKIT_ID]);
        expect(settled.toolkitChanges).toEqual([]);
        expect(buildCount).toBe(2);
        controller.dispose();
      }),
  );

  it.live("reports progress immediately and publishes only after setup finishes", () =>
    Effect.gen(function* () {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const manager = makeManagedPythonEnvironmentManager(
        computeDir,
        dependencies({
          provision: async ({ targetRoot, onProgress }) => {
            onProgress?.({ phase: "downloading", downloadedBytes: 5, totalBytes: 10 });
            await gate;
            return await executableAt(targetRoot);
          },
        }),
      );
      const controller = makeManagedPythonRuntimeController({ manager, toolkitIds: [TOOLKIT_ID] });

      const started = yield* controller.manage("install");
      expect(started).toMatchObject({ installed: false, operation: { action: "install" } });
      expect(
        yield* waitForStatus(controller, (status) => status.operation?.phase === "downloading"),
      ).toMatchObject({
        operation: { phase: "downloading", downloadedBytes: 5, totalBytes: 10 },
      });
      release();
      const settled = yield* waitForSettled(controller);
      expect(settled).toMatchObject({
        installed: true,
        selection: "managed",
        updateAvailable: false,
        operation: null,
        failureMessage: null,
      });
      controller.dispose();
    }),
  );

  it.live("cancels an unpublished setup without turning cancellation into a failure", () =>
    Effect.gen(function* () {
      const manager = makeManagedPythonEnvironmentManager(
        computeDir,
        dependencies({
          provision: async ({ signal }) =>
            await new Promise<never>((_resolve, reject) => {
              if (signal.aborted) {
                reject(new Error("aborted"));
                return;
              }
              signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
            }),
        }),
      );
      const controller = makeManagedPythonRuntimeController({ manager, toolkitIds: [TOOLKIT_ID] });

      expect((yield* controller.manage("install")).operation).not.toBeNull();
      yield* controller.cancel();
      const settled = yield* waitForSettled(controller);
      expect(settled).toMatchObject({
        installed: false,
        operation: null,
        failureMessage: null,
      });
      controller.dispose();
    }),
  );

  it.live("publishes a stable failure contract without parsing backend prose", () =>
    Effect.gen(function* () {
      const manager = makeManagedPythonEnvironmentManager(
        computeDir,
        dependencies({
          provision: async () => {
            throw new Error("private fixture detail");
          },
        }),
      );
      const controller = makeManagedPythonRuntimeController({ manager, toolkitIds: [TOOLKIT_ID] });

      yield* controller.manage("install");
      expect(yield* waitForSettled(controller)).toMatchObject({
        installed: false,
        failure: {
          reason: "provision-failed",
          action: "install",
          summary: "Scientific Python setup failed",
          detail: expect.stringContaining("private fixture detail"),
        },
      });
      controller.dispose();
    }),
  );

  it.live("coalesces concurrent setup commands into one provisioned generation", () =>
    Effect.gen(function* () {
      let release!: () => void;
      let provisions = 0;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const manager = makeManagedPythonEnvironmentManager(
        computeDir,
        dependencies({
          provision: async ({ targetRoot }) => {
            provisions += 1;
            await gate;
            return await executableAt(targetRoot);
          },
        }),
      );
      const controller = makeManagedPythonRuntimeController({ manager, toolkitIds: [TOOLKIT_ID] });

      const [first, second] = yield* Effect.all(
        [controller.manage("install"), controller.manage("install")],
        { concurrency: "unbounded" },
      );
      expect(first.operation).toMatchObject({ action: "install" });
      expect(first.operation?.operationId).toBe(second.operation?.operationId);
      yield* waitForStatus(controller, () => provisions === 1);
      expect(provisions).toBe(1);
      release();
      expect(yield* waitForSettled(controller)).toMatchObject({ installed: true, operation: null });
      controller.dispose();
    }),
  );

  it.live("offers an update only for an older activation receipt", () =>
    Effect.gen(function* () {
      const ids = ["old", "new"];
      const manager = makeManagedPythonEnvironmentManager(
        computeDir,
        dependencies({ generationId: () => ids.shift()! }),
      );
      yield* Effect.promise(() =>
        manager.install({
          toolkitIds: [TOOLKIT_ID],
          toolkitRevision: "older-toolkit",
          pythonVersion: "3.11.0",
          provisionerVersion: "older-provisioner",
          signal: new AbortController().signal,
        }),
      );
      const controller = makeManagedPythonRuntimeController({ manager, toolkitIds: [TOOLKIT_ID] });

      expect(yield* controller.status()).toMatchObject({ updateAvailable: true });
      yield* controller.manage("update");
      const settled = yield* waitForSettled(controller);
      expect(settled).toMatchObject({
        updateAvailable: false,
        runtimeVersion: `Python ${MANAGED_PYTHON_VERSION}`,
        toolkitRevision: MANAGED_PYTHON_TOOLKIT_REVISION,
      });
      expect(
        (yield* Effect.promise(() => manager.inspect()))?.record.active.provisionerVersion,
      ).toBe(MANAGED_PYTHON_PROVISIONER_VERSION);
      controller.dispose();
    }),
  );

  it.live("uses an alternate managed recipe's independently qualified Python version", () =>
    Effect.gen(function* () {
      const helperPythonVersion = "3.12.13";
      let provisionedPythonVersion: string | null = null;
      const manager = makeManagedPythonEnvironmentManager(
        computeDir,
        dependencies({
          provision: async ({ targetRoot, pythonVersion }) => {
            provisionedPythonVersion = pythonVersion;
            return await executableAt(targetRoot);
          },
        }),
        "matlab-connection",
      );
      const controller = makeManagedPythonRuntimeController({
        manager,
        toolkitIds: [],
        configuration: {
          displayName: "MATLAB connection helper",
          description: "Test helper",
          toolkitRevision: "matlab-connection-test",
          pythonVersion: helperPythonVersion,
        },
      });

      yield* controller.manage("install");
      const settled = yield* waitForSettled(controller);
      expect(provisionedPythonVersion).toBe(helperPythonVersion);
      expect(settled).toMatchObject({
        updateAvailable: false,
        runtimeVersion: `Python ${helperPythonVersion}`,
        toolkitRevision: "matlab-connection-test",
      });
      controller.dispose();
    }),
  );

  it.live("provisions an explicit Toolkit set and preserves an existing runtime selection", () =>
    Effect.gen(function* () {
      let provisionedToolkitIds: ReadonlyArray<ComputeToolkitId> = [];
      const manager = makeManagedPythonEnvironmentManager(
        computeDir,
        dependencies({
          provision: async ({ targetRoot, toolkitIds }) => {
            provisionedToolkitIds = toolkitIds;
            return await executableAt(targetRoot);
          },
        }),
      );
      const controller = makeManagedPythonRuntimeController({
        manager,
        toolkitIds: [TOOLKIT_ID, OPTIONAL_TOOLKIT_ID],
        requiredToolkitIds: [TOOLKIT_ID],
      });

      yield* controller.manage("install", {
        toolkitIds: [OPTIONAL_TOOLKIT_ID],
        selectionAfterInstall: "existing",
      });
      const settled = yield* waitForSettled(controller);
      expect(settled).toMatchObject({
        installed: true,
        selection: "existing",
        toolkitIds: [TOOLKIT_ID, OPTIONAL_TOOLKIT_ID],
      });
      expect(provisionedToolkitIds).toEqual([TOOLKIT_ID, OPTIONAL_TOOLKIT_ID]);
      controller.dispose();
    }),
  );

  it.live("rebuilds only when the requested Toolkit set changes", () =>
    Effect.gen(function* () {
      let provisions = 0;
      const manager = makeManagedPythonEnvironmentManager(
        computeDir,
        dependencies({
          provision: async ({ targetRoot }) => {
            provisions += 1;
            return await executableAt(targetRoot);
          },
        }),
      );
      const controller = makeManagedPythonRuntimeController({
        manager,
        toolkitIds: [TOOLKIT_ID, OPTIONAL_TOOLKIT_ID],
        requiredToolkitIds: [TOOLKIT_ID],
      });

      yield* controller.manage("install");
      yield* waitForSettled(controller);
      yield* controller.manage("update", { toolkitIds: [TOOLKIT_ID] });
      expect((yield* controller.status()).operation).toBeNull();
      yield* controller.manage("update", { toolkitIds: [OPTIONAL_TOOLKIT_ID] });
      expect((yield* waitForSettled(controller)).toolkitIds).toEqual([
        TOOLKIT_ID,
        OPTIONAL_TOOLKIT_ID,
      ]);
      expect(provisions).toBe(2);
      controller.dispose();
    }),
  );

  it.live("rejects provisioning options on actions that cannot use them", () =>
    Effect.gen(function* () {
      const manager = makeManagedPythonEnvironmentManager(computeDir, dependencies());
      const controller = makeManagedPythonRuntimeController({ manager, toolkitIds: [TOOLKIT_ID] });

      const toolkitError = yield* Effect.flip(
        controller.manage("use-existing", { toolkitIds: [TOOLKIT_ID] }),
      );
      expect(toolkitError).toMatchObject({
        message: "Toolkits can be chosen only while provisioning a runtime.",
      });
      const selectionError = yield* Effect.flip(
        controller.manage("repair", { selectionAfterInstall: "existing" }),
      );
      expect(selectionError).toMatchObject({
        message: "Runtime selection can be chosen only during first setup.",
      });
      controller.dispose();
    }),
  );

  it.live("keeps a broken selected installation repairable and publishes a new generation", () =>
    Effect.gen(function* () {
      const manager = makeManagedPythonEnvironmentManager(computeDir, dependencies());
      const controller = makeManagedPythonRuntimeController({ manager, toolkitIds: [TOOLKIT_ID] });
      yield* controller.manage("install");
      const installed = yield* waitForSettled(controller);
      const current = yield* Effect.promise(() => manager.inspect());
      yield* Effect.promise(() => NodeFSP.unlink(current!.executable));
      expect(yield* controller.status()).toMatchObject({
        installed: true,
        selection: "managed",
        generationId: installed.generationId,
        failureMessage: expect.stringContaining("Repair"),
        failure: {
          reason: "activation-failed",
          action: "repair",
          summary: "Scientific Python needs repair",
        },
      });
      yield* controller.manage("repair");
      const repaired = yield* waitForSettled(controller);
      expect(repaired.generationId).not.toBe(installed.generationId);
      expect(repaired).toMatchObject({
        installed: true,
        selection: "managed",
        failureMessage: null,
        failure: null,
      });
      controller.dispose();
    }),
  );

  it.live("keeps session admission blocked until private removal settles", () =>
    Effect.gen(function* () {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const manager = makeManagedPythonEnvironmentManager(
        computeDir,
        dependencies({
          removeTree: async (root) => {
            await gate;
            await NodeFSP.rm(root, { recursive: true, force: true });
          },
        }),
      );
      yield* Effect.promise(() =>
        manager.install({
          toolkitIds: [TOOLKIT_ID],
          toolkitRevision: MANAGED_PYTHON_TOOLKIT_REVISION,
          pythonVersion: MANAGED_PYTHON_VERSION,
          provisionerVersion: MANAGED_PYTHON_PROVISIONER_VERSION,
          signal: new AbortController().signal,
        }),
      );
      const controller = makeManagedPythonRuntimeController({ manager, toolkitIds: [TOOLKIT_ID] });
      expect(controller.isRemoving()).toBe(false);
      yield* controller.manage("remove");
      expect(controller.isRemoving()).toBe(true);
      release();
      expect(yield* waitForSettled(controller)).toMatchObject({
        installed: false,
        operation: null,
      });
      expect(controller.isRemoving()).toBe(false);
      controller.dispose();
    }),
  );
});

type Controller = ReturnType<typeof makeManagedPythonRuntimeController>;

const waitForSettled = (controller: Controller) =>
  waitForStatus(
    controller,
    (status) =>
      status.operation === null &&
      !status.toolkitChanges?.some((entry) => entry.state !== "failed"),
  );

const waitForStatus = Effect.fn("ManagedPythonRuntimeController.waitForStatus")(function* (
  controller: Controller,
  accepted: (status: ComputeManagedRuntimeStatus) => boolean,
) {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    const status = yield* controller.status();
    if (accepted(status)) return status;
    yield* Effect.sleep("1 millis");
  }
  return yield* Effect.die(new Error("Managed runtime operation did not settle."));
});
