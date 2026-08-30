// @effect-diagnostics nodeBuiltinImport:off -- these tests exercise the private filesystem boundary.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { ComputeProjectId, ComputeToolkitId } from "@scientfactory/compute";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { afterEach, beforeEach, describe, expect } from "vite-plus/test";

import {
  ManagedPythonEnvironmentError,
  type ManagedPythonEnvironmentDependencies,
  makeManagedPythonEnvironmentManager,
  managedPythonEnvironmentPaths,
} from "./ManagedPythonEnvironment.ts";

const PROJECT_ID = ComputeProjectId.make("project-1");
const TOOLKIT_ID = ComputeToolkitId.make("python-data-and-figures");

describe("managed Python environment", () => {
  let temporaryRoot: string;
  let computeDir: string;

  beforeEach(async () => {
    temporaryRoot = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-managed-python-"));
    computeDir = NodePath.join(temporaryRoot, "compute");
  });

  afterEach(async () => {
    await NodeFSP.rm(temporaryRoot, { recursive: true, force: true });
  });

  function generationSequence(...values: ReadonlyArray<string>): () => string {
    const remaining = [...values];
    return () => {
      const next = remaining.shift();
      if (next === undefined) throw new Error("The test exhausted its generation IDs.");
      return next;
    };
  }

  async function materializePython(targetRoot: string): Promise<string> {
    const executableRelativePath = NodePath.join("bin", "python");
    const executable = NodePath.join(targetRoot, executableRelativePath);
    await NodeFSP.mkdir(NodePath.dirname(executable), { recursive: true });
    await NodeFSP.writeFile(executable, "test python");
    return executableRelativePath;
  }

  function dependencies(
    overrides: Partial<ManagedPythonEnvironmentDependencies> = {},
  ): ManagedPythonEnvironmentDependencies {
    return {
      provision: async ({ targetRoot }) => ({
        executableRelativePath: await materializePython(targetRoot),
      }),
      verify: async () => undefined,
      now: () => 1_777_777,
      generationId: generationSequence("first"),
      ...overrides,
    };
  }

  const installInput = (signal: AbortSignal) => ({
    projectId: PROJECT_ID,
    toolkitIds: [TOOLKIT_ID],
    signal,
  });

  it("derives an opaque app-owned project root", () => {
    const paths = managedPythonEnvironmentPaths(computeDir, PROJECT_ID);

    expect(paths.managedRoot).toBe(NodePath.join(computeDir, "environments", "python"));
    expect(NodePath.dirname(paths.projectRoot)).toBe(paths.managedRoot);
    expect(NodePath.basename(paths.projectRoot)).toMatch(/^[a-f0-9]{64}$/u);
    expect(paths.projectRoot).not.toContain(PROJECT_ID);
  });

  it("publishes only a provisioned and verified final-path generation", async () => {
    const provisionedRoots: string[] = [];
    const verifiedExecutables: string[] = [];
    const manager = makeManagedPythonEnvironmentManager(
      computeDir,
      dependencies({
        provision: async ({ targetRoot }) => {
          provisionedRoots.push(targetRoot);
          return { executableRelativePath: await materializePython(targetRoot) };
        },
        verify: async ({ executable }) => {
          verifiedExecutables.push(executable);
        },
      }),
    );

    const installed = await manager.install(installInput(new AbortController().signal));
    const inspected = await manager.inspect(PROJECT_ID);
    const stateMode = (
      await NodeFSP.stat(managedPythonEnvironmentPaths(computeDir, PROJECT_ID).statePath)
    ).mode;

    expect(provisionedRoots).toEqual([installed.record.active.root]);
    expect(verifiedExecutables).toEqual([installed.executable]);
    expect(inspected).toEqual(installed);
    expect(installed.record).toMatchObject({
      schemaVersion: 1,
      projectId: PROJECT_ID,
      active: {
        generationId: "first",
        toolkitIds: [TOOLKIT_ID],
        activatedAtEpochMs: 1_777_777,
      },
      previous: null,
    });
    expect(stateMode & 0o777).toBe(0o600);
  });

  it("snapshots the requested Toolkit set before asynchronous setup begins", async () => {
    const requested = [TOOLKIT_ID];
    let provisionedToolkitIds: ReadonlyArray<string> = [];
    const manager = makeManagedPythonEnvironmentManager(
      computeDir,
      dependencies({
        provision: async ({ targetRoot, toolkitIds }) => {
          provisionedToolkitIds = [...toolkitIds];
          return { executableRelativePath: await materializePython(targetRoot) };
        },
      }),
    );

    const installing = manager.install({
      projectId: PROJECT_ID,
      toolkitIds: requested,
      signal: new AbortController().signal,
    });
    requested.length = 0;
    const installed = await installing;

    expect(provisionedToolkitIds).toEqual([TOOLKIT_ID]);
    expect(installed.record.active.toolkitIds).toEqual([TOOLKIT_ID]);
  });

  it("retains one rollback generation and cleans only older app-owned generations", async () => {
    const manager = makeManagedPythonEnvironmentManager(
      computeDir,
      dependencies({ generationId: generationSequence("first", "second", "third") }),
    );
    const signal = new AbortController().signal;

    const first = await manager.install(installInput(signal));
    const second = await manager.repair(installInput(signal));
    const third = await manager.repair(installInput(signal));

    expect(second.record.previous?.generationId).toBe("first");
    expect(third.record.previous?.generationId).toBe("second");
    await expect(NodeFSP.access(first.record.active.root)).rejects.toThrow();
    await expect(NodeFSP.access(second.record.active.root)).resolves.toBeUndefined();
    await expect(NodeFSP.access(third.record.active.root)).resolves.toBeUndefined();
  });

  it("preserves the active generation when provisioning fails", async () => {
    let shouldFail = false;
    const manager = makeManagedPythonEnvironmentManager(
      computeDir,
      dependencies({
        generationId: generationSequence("first", "failed"),
        provision: async ({ targetRoot }) => {
          if (shouldFail) throw new Error("provision failed");
          return { executableRelativePath: await materializePython(targetRoot) };
        },
      }),
    );
    const signal = new AbortController().signal;
    const first = await manager.install(installInput(signal));
    shouldFail = true;

    await expect(manager.repair(installInput(signal))).rejects.toMatchObject({
      reason: "provision-failed",
    });

    expect((await manager.inspect(PROJECT_ID))?.record.active.generationId).toBe("first");
    await expect(NodeFSP.access(first.record.active.root)).resolves.toBeUndefined();
    await expect(
      NodeFSP.access(
        NodePath.join(NodePath.dirname(first.record.active.root), "generation-failed"),
      ),
    ).rejects.toThrow();
  });

  it("preserves the active generation when exact-environment verification fails", async () => {
    let shouldFail = false;
    const manager = makeManagedPythonEnvironmentManager(
      computeDir,
      dependencies({
        generationId: generationSequence("first", "failed"),
        verify: async () => {
          if (shouldFail) throw new Error("verification failed");
        },
      }),
    );
    const signal = new AbortController().signal;
    await manager.install(installInput(signal));
    shouldFail = true;

    await expect(manager.repair(installInput(signal))).rejects.toMatchObject({
      reason: "verification-failed",
    });

    expect((await manager.inspect(PROJECT_ID))?.record.active.generationId).toBe("first");
  });

  it("preserves the active state when its atomic activation cannot commit", async () => {
    let shouldFail = false;
    const commitState: NonNullable<ManagedPythonEnvironmentDependencies["commitState"]> = async (
      statePath,
      record,
    ) => {
      if (shouldFail) throw new Error("commit failed");
      await NodeFSP.writeFile(statePath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    };
    const manager = makeManagedPythonEnvironmentManager(
      computeDir,
      dependencies({
        generationId: generationSequence("first", "failed"),
        commitState,
      }),
    );
    const signal = new AbortController().signal;
    const first = await manager.install(installInput(signal));
    shouldFail = true;

    await expect(manager.repair(installInput(signal))).rejects.toMatchObject({
      reason: "activation-failed",
    });

    expect(await manager.inspect(PROJECT_ID)).toEqual(first);
    await expect(
      NodeFSP.access(
        NodePath.join(NodePath.dirname(first.record.active.root), "generation-failed"),
      ),
    ).rejects.toThrow();
  });

  it("cancels before activation and removes the unpublished candidate", async () => {
    const controller = new AbortController();
    const manager = makeManagedPythonEnvironmentManager(
      computeDir,
      dependencies({
        provision: async ({ targetRoot }) => {
          const executableRelativePath = await materializePython(targetRoot);
          controller.abort();
          return { executableRelativePath };
        },
      }),
    );

    await expect(manager.install(installInput(controller.signal))).rejects.toMatchObject({
      reason: "cancelled",
    });

    expect(await manager.inspect(PROJECT_ID)).toBeNull();
    const entries = await NodeFSP.readdir(
      managedPythonEnvironmentPaths(computeDir, PROJECT_ID).projectRoot,
    );
    expect(entries).toEqual([]);
  });

  it.effect("rejects an executable symlink that escapes the managed generation", () =>
    Effect.gen(function* () {
      if ((yield* HostProcessPlatform) === "win32") return;
      yield* Effect.promise(async () => {
        const externalExecutable = NodePath.join(temporaryRoot, "external-python");
        await NodeFSP.writeFile(externalExecutable, "external");
        let verifyCalls = 0;
        const manager = makeManagedPythonEnvironmentManager(
          computeDir,
          dependencies({
            provision: async ({ targetRoot }) => {
              const executableRelativePath = NodePath.join("bin", "python");
              const executable = NodePath.join(targetRoot, executableRelativePath);
              await NodeFSP.mkdir(NodePath.dirname(executable), { recursive: true });
              await NodeFSP.symlink(externalExecutable, executable);
              return { executableRelativePath };
            },
            verify: async () => {
              verifyCalls += 1;
            },
          }),
        );

        await expect(
          manager.install(installInput(new AbortController().signal)),
        ).rejects.toMatchObject({ reason: "verification-failed" });

        expect(verifyCalls).toBe(0);
        await expect(NodeFSP.readFile(externalExecutable, "utf8")).resolves.toBe("external");
      });
    }),
  );

  it("rejects a provisioner path that lexically escapes its generation", async () => {
    let verifyCalls = 0;
    const manager = makeManagedPythonEnvironmentManager(
      computeDir,
      dependencies({
        provision: async () => ({ executableRelativePath: "../../external-python" }),
        verify: async () => {
          verifyCalls += 1;
        },
      }),
    );

    await expect(manager.install(installInput(new AbortController().signal))).rejects.toMatchObject(
      { reason: "verification-failed" },
    );
    expect(verifyCalls).toBe(0);
  });

  it("removes only the app-owned project environment", async () => {
    const manager = makeManagedPythonEnvironmentManager(computeDir, dependencies());
    const installed = await manager.install(installInput(new AbortController().signal));
    const sibling = NodePath.join(
      managedPythonEnvironmentPaths(computeDir, PROJECT_ID).managedRoot,
      "unrelated",
    );
    await NodeFSP.mkdir(sibling, { recursive: true });

    await expect(manager.remove(PROJECT_ID)).resolves.toBe(true);

    await expect(NodeFSP.access(NodePath.dirname(installed.record.active.root))).rejects.toThrow();
    await expect(NodeFSP.access(sibling)).resolves.toBeUndefined();
    await expect(manager.remove(PROJECT_ID)).resolves.toBe(false);
  });

  it("rolls back the atomic removal when deleting its tombstone fails", async () => {
    const manager = makeManagedPythonEnvironmentManager(
      computeDir,
      dependencies({
        removeTree: async () => {
          throw new Error("remove failed");
        },
      }),
    );
    const installed = await manager.install(installInput(new AbortController().signal));

    await expect(manager.remove(PROJECT_ID)).rejects.toMatchObject({
      reason: "remove-failed",
      message:
        "Scient could not remove the managed Python environment; the previous environment was restored.",
    });

    expect(await manager.inspect(PROJECT_ID)).toEqual(installed);
  });

  it("ignores a tampered state that points outside the app-owned project root", async () => {
    const paths = managedPythonEnvironmentPaths(computeDir, PROJECT_ID);
    const externalRoot = NodePath.join(temporaryRoot, "generation-external");
    await NodeFSP.mkdir(NodePath.join(externalRoot, "bin"), { recursive: true });
    await NodeFSP.writeFile(NodePath.join(externalRoot, "bin", "python"), "external");
    await NodeFSP.mkdir(paths.projectRoot, { recursive: true });
    await NodeFSP.writeFile(
      paths.statePath,
      JSON.stringify({
        schemaVersion: 1,
        projectId: PROJECT_ID,
        active: {
          generationId: "external",
          root: externalRoot,
          executableRelativePath: "bin/python",
          toolkitIds: [TOOLKIT_ID],
          activatedAtEpochMs: 1,
        },
        previous: null,
      }),
    );
    const manager = makeManagedPythonEnvironmentManager(computeDir, dependencies());

    expect(await manager.inspect(PROJECT_ID)).toBeNull();
    await manager.remove(PROJECT_ID);
    await expect(
      NodeFSP.readFile(NodePath.join(externalRoot, "bin", "python"), "utf8"),
    ).resolves.toBe("external");
  });

  it("does not expose a tampered previous generation as a rollback candidate", async () => {
    const manager = makeManagedPythonEnvironmentManager(computeDir, dependencies());
    const installed = await manager.install(installInput(new AbortController().signal));
    const paths = managedPythonEnvironmentPaths(computeDir, PROJECT_ID);
    await NodeFSP.writeFile(
      paths.statePath,
      JSON.stringify({
        ...installed.record,
        previous: {
          ...installed.record.active,
          generationId: "external",
          root: NodePath.join(temporaryRoot, "generation-external"),
        },
      }),
    );

    expect((await manager.inspect(PROJECT_ID))?.record.previous).toBeNull();
  });

  it("serializes mutations so two installs never provision concurrently", async () => {
    let activeProvisioners = 0;
    let maximumActiveProvisioners = 0;
    let provisionCalls = 0;
    let markFirstEntered!: () => void;
    let releaseFirst!: () => void;
    const firstEntered = new Promise<void>((resolve) => {
      markFirstEntered = resolve;
    });
    const firstCanFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const manager = makeManagedPythonEnvironmentManager(
      computeDir,
      dependencies({
        generationId: generationSequence("first", "second"),
        provision: async ({ targetRoot }) => {
          provisionCalls += 1;
          activeProvisioners += 1;
          maximumActiveProvisioners = Math.max(maximumActiveProvisioners, activeProvisioners);
          if (provisionCalls === 1) {
            markFirstEntered();
            await firstCanFinish;
          }
          const executableRelativePath = await materializePython(targetRoot);
          activeProvisioners -= 1;
          return { executableRelativePath };
        },
      }),
    );
    const signal = new AbortController().signal;

    const first = manager.install(installInput(signal));
    await firstEntered;
    const second = manager.repair(installInput(signal));
    await Promise.resolve();
    expect(activeProvisioners).toBe(1);
    releaseFirst();
    await Promise.all([first, second]);

    expect(maximumActiveProvisioners).toBe(1);
    expect((await manager.inspect(PROJECT_ID))?.record.active.generationId).toBe("second");
  });

  it("rejects empty or duplicate Toolkit requests before creating state", async () => {
    const manager = makeManagedPythonEnvironmentManager(computeDir, dependencies());
    const signal = new AbortController().signal;

    await expect(
      manager.install({ projectId: PROJECT_ID, toolkitIds: [], signal }),
    ).rejects.toBeInstanceOf(ManagedPythonEnvironmentError);
    await expect(
      manager.install({ projectId: PROJECT_ID, toolkitIds: [TOOLKIT_ID, TOOLKIT_ID], signal }),
    ).rejects.toMatchObject({ reason: "invalid-request" });
    const cancelled = new AbortController();
    cancelled.abort();
    await expect(manager.install(installInput(cancelled.signal))).rejects.toMatchObject({
      reason: "cancelled",
    });
    await expect(
      NodeFSP.access(managedPythonEnvironmentPaths(computeDir, PROJECT_ID).projectRoot),
    ).rejects.toThrow();
  });
});
