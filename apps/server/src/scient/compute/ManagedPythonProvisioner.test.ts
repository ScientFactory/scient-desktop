// @effect-diagnostics nodeBuiltinImport:off -- fixture paths verify source and packaged layout.
import * as NodeFSP from "node:fs/promises";
import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { ExecutionProcessPort } from "@scientfactory/execution";
import { ComputeToolkitId } from "@scientfactory/compute";
import { downloadManagedRuntime, type ManagedRuntimeTarget } from "@scientfactory/provider-runtime";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  MANAGED_PYTHON_LOCK_SHA256,
  MANAGED_PYTHON_PROJECT_SHA256,
  MANAGED_PYTHON_UV_VERSION,
  MANAGED_PYTHON_VERSION,
  makeManagedPythonProvisioner,
  managedPythonExtrasForToolkits,
  managedPythonProvisioningEnvironment,
  managedPythonSpecPathCandidates,
  managedPythonUvArtifactForTarget,
  resolveManagedPythonSpecPath,
} from "./ManagedPythonProvisioner.ts";
import {
  PYTHON_BIOINFORMATICS_TOOLKIT,
  PYTHON_DATA_AND_FIGURES_TOOLKIT,
  PYTHON_IMAGE_ANALYSIS_TOOLKIT,
  PYTHON_LARGE_DATA_TOOLKIT,
} from "./PythonToolkitCatalog.ts";

vi.mock("@scientfactory/provider-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@scientfactory/provider-runtime")>()),
  downloadManagedRuntime: vi.fn(),
}));

describe("ManagedPythonProvisioner", () => {
  let temporaryRoot: string;

  beforeEach(async () => {
    temporaryRoot = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-python-spec-"));
    vi.mocked(downloadManagedRuntime).mockReset().mockRejectedValue(new Error("Fixture offline"));
  });

  afterEach(async () => {
    await NodeFSP.rm(temporaryRoot, { recursive: true, force: true });
  });

  const cachedInstaller = async (processes: ExecutionProcessPort) => {
    const computeDir = NodePath.join(temporaryRoot, "compute");
    const versionRoot = NodePath.join(computeDir, "tooling", "uv", MANAGED_PYTHON_UV_VERSION);
    const artifact = managedPythonUvArtifactForTarget({ platform: "darwin", arch: "arm64" });
    const executable = NodePath.join(versionRoot, "darwin-arm64", artifact.executablePath);
    const auxiliaryExecutable = NodePath.join(
      versionRoot,
      "darwin-arm64",
      artifact.auxiliaryExecutablePath,
    );
    const executableFixture = "cached-installer-fixture";
    const auxiliaryFixture = "cached-auxiliary-fixture";
    await NodeFSP.mkdir(NodePath.dirname(executable), { recursive: true });
    await NodeFSP.writeFile(executable, executableFixture);
    await NodeFSP.writeFile(auxiliaryExecutable, auxiliaryFixture);
    const provisioner = makeManagedPythonProvisioner({
      computeDir,
      specDirectory: NodePath.join(import.meta.dirname, "managed-python"),
      processes,
      spawnProbe: () => Effect.die("The cancelled setup must not reach a Python probe."),
      environment: {},
      platform: "darwin",
      arch: "arm64",
      uvArtifact: {
        ...artifact,
        executableSha256: NodeCrypto.createHash("sha256").update(executableFixture).digest("hex"),
        auxiliaryExecutableSha256: NodeCrypto.createHash("sha256")
          .update(auxiliaryFixture)
          .digest("hex"),
      },
    });
    return {
      executable,
      versionRoot,
      provision: (
        signal: AbortSignal,
        generation = "generation",
        interpreter: {
          freshInterpreter?: boolean;
          interpreterRelativePath?: string | undefined;
        } = {},
      ) =>
        provisioner.provision({
          ...interpreter,
          targetRoot: NodePath.join(temporaryRoot, generation),
          toolkitIds: [],
          toolkitRevision: "fixture",
          pythonVersion: MANAGED_PYTHON_VERSION,
          provisionerVersion: "fixture",
          signal,
        }),
    };
  };

  it.each([0, 3 * 1024 ** 3])(
    "reuses only the private artifact cache and enforces retention at %s bytes",
    async (bytes) => {
      const commands: Parameters<ExecutionProcessPort["start"]>[0][] = [];
      const fixture = await cachedInstaller({
        start: (input) => {
          commands.push(input);
          if (input.args[0] === "python" && input.args[1] === "find")
            return Effect.promise(async () => {
              const interpreter = NodePath.join(
                input.environment!.UV_PYTHON_INSTALL_DIR!,
                "cpython-fixture",
                "bin",
                "python3.14",
              );
              await NodeFSP.mkdir(NodePath.dirname(interpreter), { recursive: true });
              await NodeFSP.writeFile(interpreter, "fixture");
              return {
                output: Stream.make({ stream: "stdout" as const, text: interpreter }),
                exitCode: Effect.succeed(0),
                cancel: Effect.void,
              };
            });
          if (input.args[0] === "sync")
            return Effect.promise(async () => {
              await NodeFSP.mkdir(input.environment!.UV_PROJECT_ENVIRONMENT!, { recursive: true });
              return { output: Stream.empty, exitCode: Effect.succeed(0), cancel: Effect.void };
            });
          const text =
            input.args[0] === "--version"
              ? `uv ${MANAGED_PYTHON_UV_VERSION}`
              : input.args[1] === "size"
                ? String(bytes)
                : "";
          return Effect.succeed({
            output: Stream.make(
              {
                stream: "stderr" as const,
                text: input.args[1] === "size" ? "fixture diagnostic\n" : "",
              },
              { stream: "stdout" as const, text },
            ),
            exitCode: Effect.succeed(0),
            cancel: Effect.void,
          });
        },
      });
      await NodeFSP.mkdir(NodePath.join(temporaryRoot, "generation"));
      await NodeFSP.mkdir(NodePath.join(temporaryRoot, "generation-two"));
      await fixture.provision(new AbortController().signal);
      await fixture.provision(new AbortController().signal, "generation-two");
      const syncs = commands.filter((command) => command.args[0] === "sync");
      expect(syncs).toHaveLength(2);
      const cache = NodePath.join(temporaryRoot, "compute", "cache", "python");
      expect(syncs.map((command) => command.environment?.UV_CACHE_DIR)).toEqual([cache, cache]);
      expect(syncs[0]?.environment?.UV_PROJECT_ENVIRONMENT).not.toEqual(
        syncs[1]?.environment?.UV_PROJECT_ENVIRONMENT,
      );
      expect(syncs[0]?.environment?.UV_PYTHON_INSTALL_DIR).toEqual(
        syncs[1]?.environment?.UV_PYTHON_INSTALL_DIR,
      );
      expect(syncs.every((command) => command.args.includes("clone"))).toBe(true);
      expect(commands.filter((command) => command.args[1] === "clean")).toHaveLength(
        bytes === 0 ? 0 : 4,
      );
      expect((await NodeFSP.stat(cache)).isDirectory()).toBe(true);
      await NodeFSP.mkdir(NodePath.join(temporaryRoot, "repair"));
      const repaired = await fixture.provision(new AbortController().signal, "repair", {
        freshInterpreter: true,
      });
      const repairedStore = commands.findLast((command) => command.args[0] === "sync")!.environment!
        .UV_PYTHON_INSTALL_DIR;
      expect(repairedStore).not.toBe(syncs[0]?.environment?.UV_PYTHON_INSTALL_DIR);
      await NodeFSP.mkdir(NodePath.join(temporaryRoot, "after-repair"));
      await fixture.provision(new AbortController().signal, "after-repair", {
        interpreterRelativePath: repaired.interpreterRelativePath,
      });
      expect(
        commands.findLast((command) => command.args[0] === "sync")!.environment!
          .UV_PYTHON_INSTALL_DIR,
      ).toBe(repairedStore);
    },
  );

  it("rejects a redirected artifact cache without touching its target", async () => {
    const fixture = await cachedInstaller({
      start: () =>
        Effect.succeed({
          output: Stream.make({
            stream: "stdout" as const,
            text: `uv ${MANAGED_PYTHON_UV_VERSION}`,
          }),
          exitCode: Effect.succeed(0),
          cancel: Effect.void,
        }),
    });
    const outside = NodePath.join(temporaryRoot, "user-cache");
    await NodeFSP.mkdir(outside);
    await NodeFSP.writeFile(NodePath.join(outside, "keep"), "user data");
    await NodeFSP.symlink(outside, NodePath.join(temporaryRoot, "compute", "cache"));
    await expect(fixture.provision(new AbortController().signal)).rejects.toThrow("not a link");
    expect(await NodeFSP.readFile(NodePath.join(outside, "keep"), "utf8")).toBe("user data");
  });

  it("rejects a redirected installer cache before inspecting or replacing its target", async () => {
    const computeDir = NodePath.join(temporaryRoot, "compute");
    const outside = NodePath.join(temporaryRoot, "user-tooling");
    await NodeFSP.mkdir(computeDir);
    await NodeFSP.mkdir(outside);
    await NodeFSP.writeFile(NodePath.join(outside, "keep"), "user data");
    await NodeFSP.symlink(outside, NodePath.join(computeDir, "tooling"));
    const provisioner = makeManagedPythonProvisioner({
      computeDir,
      specDirectory: NodePath.join(import.meta.dirname, "managed-python"),
      processes: {
        start: () => Effect.die("A redirected installer cache must fail before execution."),
      },
      spawnProbe: () => Effect.die("A redirected installer cache must fail before probing."),
      environment: {},
      platform: "darwin",
      arch: "arm64",
    });

    await expect(
      provisioner.provision({
        targetRoot: NodePath.join(temporaryRoot, "generation"),
        toolkitIds: [],
        toolkitRevision: "fixture",
        pythonVersion: MANAGED_PYTHON_VERSION,
        provisionerVersion: "fixture",
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("managed installer cache must be an app-owned directory, not a link");
    expect(await NodeFSP.readFile(NodePath.join(outside, "keep"), "utf8")).toBe("user data");
    expect(downloadManagedRuntime).not.toHaveBeenCalled();
  });

  it("rejects a redirected installer target before inspecting its payload", async () => {
    const computeDir = NodePath.join(temporaryRoot, "compute");
    const versionRoot = NodePath.join(computeDir, "tooling", "uv", MANAGED_PYTHON_UV_VERSION);
    const outside = NodePath.join(temporaryRoot, "user-installer");
    await NodeFSP.mkdir(versionRoot, { recursive: true });
    await NodeFSP.mkdir(outside);
    await NodeFSP.writeFile(NodePath.join(outside, "keep"), "user data");
    await NodeFSP.symlink(outside, NodePath.join(versionRoot, "darwin-arm64"));
    const provisioner = makeManagedPythonProvisioner({
      computeDir,
      specDirectory: NodePath.join(import.meta.dirname, "managed-python"),
      processes: {
        start: () => Effect.die("A redirected installer target must fail before execution."),
      },
      spawnProbe: () => Effect.die("A redirected installer target must fail before probing."),
      environment: {},
      platform: "darwin",
      arch: "arm64",
    });

    await expect(
      provisioner.provision({
        targetRoot: NodePath.join(temporaryRoot, "generation"),
        toolkitIds: [],
        toolkitRevision: "fixture",
        pythonVersion: MANAGED_PYTHON_VERSION,
        provisionerVersion: "fixture",
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("managed installer cache must be an app-owned directory, not a link");
    expect(await NodeFSP.readFile(NodePath.join(outside, "keep"), "utf8")).toBe("user data");
    expect(downloadManagedRuntime).not.toHaveBeenCalled();
  });

  it("keeps the cached installer when setup is already cancelled", async () => {
    const start = vi.fn(() => Effect.die("A cancelled setup must not start a process."));
    const fixture = await cachedInstaller({ start });
    const controller = new AbortController();
    controller.abort();

    await expect(fixture.provision(controller.signal)).rejects.toBeDefined();
    expect(await NodeFSP.readFile(fixture.executable, "utf8")).toBe("cached-installer-fixture");
    expect(await NodeFSP.readdir(fixture.versionRoot)).toEqual(["darwin-arm64"]);
    expect(start).not.toHaveBeenCalled();
    expect(downloadManagedRuntime).not.toHaveBeenCalled();
  });

  it("cancels an in-flight installer check without discarding its cache or retrying", async () => {
    const checking = Promise.withResolvers<void>();
    let cancellations = 0;
    const fixture = await cachedInstaller({
      start: () =>
        Effect.succeed({
          output: Stream.empty,
          exitCode: Effect.sync(() => checking.resolve()).pipe(Effect.andThen(Effect.never)),
          cancel: Effect.sync(() => {
            cancellations += 1;
          }),
        }),
    });
    const controller = new AbortController();
    const outcome = fixture.provision(controller.signal).then(
      () => "unexpected success",
      () => "cancelled",
    );
    await checking.promise;
    controller.abort();

    expect(await outcome).toBe("cancelled");
    expect(cancellations).toBe(1);
    expect(await NodeFSP.readFile(fixture.executable, "utf8")).toBe("cached-installer-fixture");
    expect(await NodeFSP.readdir(fixture.versionRoot)).toEqual(["darwin-arm64"]);
    expect(downloadManagedRuntime).not.toHaveBeenCalled();
  });

  it("still discards a mismatched installer and cleans staging when replacement is offline", async () => {
    const fixture = await cachedInstaller({
      start: () =>
        Effect.succeed({
          output: Stream.make({ stream: "stdout" as const, text: "uv 0.0.0" }),
          exitCode: Effect.succeed(0),
          cancel: Effect.void,
        }),
    });

    await expect(fixture.provision(new AbortController().signal)).rejects.toThrow(
      "Fixture offline",
    );
    await expect(NodeFSP.stat(fixture.executable)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await NodeFSP.readdir(fixture.versionRoot)).toEqual([]);
    expect(downloadManagedRuntime).toHaveBeenCalledTimes(1);
  });

  it("discards a cached installer whose payload no longer matches its pinned checksum", async () => {
    const fixture = await cachedInstaller({
      start: () => Effect.die("A corrupt payload must be rejected before it can execute."),
    });
    await NodeFSP.writeFile(fixture.executable, "tampered-installer");

    await expect(fixture.provision(new AbortController().signal)).rejects.toThrow(
      "Fixture offline",
    );
    await expect(NodeFSP.stat(fixture.executable)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await NodeFSP.readdir(fixture.versionRoot)).toEqual([]);
    expect(downloadManagedRuntime).toHaveBeenCalledTimes(1);
  });

  it("keeps the checked-in locked specification matched to its activation hashes", async () => {
    for (const [name, expected] of [
      ["pyproject.toml", MANAGED_PYTHON_PROJECT_SHA256],
      ["uv.lock", MANAGED_PYTHON_LOCK_SHA256],
    ] as const) {
      const contents = await NodeFSP.readFile(new URL(`./managed-python/${name}`, import.meta.url));
      expect(NodeCrypto.createHash("sha256").update(contents).digest("hex")).toBe(expected);
    }
  });

  it("maps only reviewed Toolkit identities to optional lock groups", () => {
    expect(
      managedPythonExtrasForToolkits([
        PYTHON_DATA_AND_FIGURES_TOOLKIT.toolkitId,
        PYTHON_LARGE_DATA_TOOLKIT.toolkitId,
        PYTHON_IMAGE_ANALYSIS_TOOLKIT.toolkitId,
        PYTHON_BIOINFORMATICS_TOOLKIT.toolkitId,
      ]),
    ).toEqual(["large-data", "image-analysis", "bioinformatics"]);
    expect(() => managedPythonExtrasForToolkits([ComputeToolkitId.make("python-unknown")])).toThrow(
      "Unknown Scientific Python Toolkit: python-unknown.",
    );
  });

  it("maps every reviewed platform target to a pinned bounded artifact", () => {
    const targets: ReadonlyArray<ManagedRuntimeTarget> = [
      { platform: "darwin", arch: "arm64" },
      { platform: "darwin", arch: "x64" },
      { platform: "linux", arch: "arm64", libc: "glibc" },
      { platform: "linux", arch: "x64", libc: "glibc" },
      { platform: "linux", arch: "arm64", libc: "musl" },
      { platform: "linux", arch: "x64", libc: "musl" },
      { platform: "win32", arch: "arm64" },
      { platform: "win32", arch: "x64" },
    ];

    for (const target of targets) {
      const artifact = managedPythonUvArtifactForTarget(target);
      expect(artifact.size).toBeGreaterThan(1_000_000);
      expect(artifact.sha256).toMatch(/^[a-f0-9]{64}$/u);
      expect(artifact.executableSha256).toMatch(/^[a-f0-9]{64}$/u);
      expect(artifact.auxiliaryExecutableSha256).toMatch(/^[a-f0-9]{64}$/u);
      expect(artifact.executablePath).toContain("uv");
      expect(artifact.auxiliaryExecutablePath).toContain("uvx");
    }
    for (const arch of ["arm64", "x64"] as const) {
      expect(managedPythonUvArtifactForTarget({ platform: "win32", arch })).toMatchObject({
        executablePath: "uv.exe",
        auxiliaryExecutablePath: "uvx.exe",
      });
    }
    expect(() => managedPythonUvArtifactForTarget({ platform: "linux", arch: "x64" })).toThrow(
      "Scientific Python is not available",
    );
  });

  it("strips ambient package-manager authority and scopes every uv path", () => {
    const environment = managedPythonProvisioningEnvironment(
      {
        PATH: "/usr/bin",
        HTTPS_PROXY: "https://proxy.example",
        UV_INDEX_URL: "https://unreviewed.example",
        PIP_CONFIG_FILE: "/tmp/pip.conf",
        POETRY_HOME: "/tmp/poetry",
        PYENV_ROOT: "/tmp/pyenv",
        CONDA_PREFIX: "/tmp/conda",
        VIRTUAL_ENV: "/tmp/venv",
      },
      { targetRoot: "/private/generation", projectRoot: "/private/generation/project" },
    );

    expect(environment).toMatchObject({
      PATH: "/usr/bin",
      HTTPS_PROXY: "https://proxy.example",
      UV_CACHE_DIR: "/private/generation/.cache",
      UV_PROJECT: "/private/generation/project",
      UV_PROJECT_ENVIRONMENT: "/private/generation/environment",
      UV_PYTHON_INSTALL_DIR: "/private/generation/python",
    });
    for (const key of [
      "UV_INDEX_URL",
      "PIP_CONFIG_FILE",
      "POETRY_HOME",
      "PYENV_ROOT",
      "CONDA_PREFIX",
      "VIRTUAL_ENV",
    ]) {
      expect(environment[key]).toBeUndefined();
    }
  });

  it("resolves source and packaged specifications without guessing another path", async () => {
    const [source, packaged] = managedPythonSpecPathCandidates(temporaryRoot);
    expect(source).toBe(NodePath.join(temporaryRoot, "managed-python"));
    expect(packaged).toBe(NodePath.join(temporaryRoot, "scient-managed-python"));
    if (source === undefined || packaged === undefined) throw new Error("Missing candidates.");

    await NodeFSP.mkdir(packaged, { recursive: true });
    await NodeFSP.writeFile(NodePath.join(packaged, "pyproject.toml"), "project");
    await NodeFSP.writeFile(NodePath.join(packaged, "uv.lock"), "lock");
    expect(await resolveManagedPythonSpecPath(temporaryRoot)).toBe(packaged);

    await NodeFSP.mkdir(source, { recursive: true });
    await NodeFSP.writeFile(NodePath.join(source, "pyproject.toml"), "project");
    await NodeFSP.writeFile(NodePath.join(source, "uv.lock"), "lock");
    expect(await resolveManagedPythonSpecPath(temporaryRoot)).toBe(source);
  });

  it("does not treat Scientific Python specs as the MATLAB connection helper", async () => {
    const [source, packaged] = managedPythonSpecPathCandidates(temporaryRoot);
    if (source === undefined || packaged === undefined) throw new Error("Missing candidates.");
    await NodeFSP.mkdir(packaged, { recursive: true });
    await NodeFSP.writeFile(NodePath.join(packaged, "pyproject.toml"), "project");
    await NodeFSP.writeFile(NodePath.join(packaged, "uv.lock"), "lock");
    await expect(resolveManagedPythonSpecPath(temporaryRoot, "matlab-connection")).rejects.toThrow(
      /MATLAB connection helper specification/,
    );

    const helper = NodePath.join(packaged, "matlab-connection");
    await NodeFSP.mkdir(helper, { recursive: true });
    await NodeFSP.writeFile(NodePath.join(helper, "pyproject.toml"), "helper-project");
    await NodeFSP.writeFile(NodePath.join(helper, "uv.lock"), "helper-lock");
    expect(await resolveManagedPythonSpecPath(temporaryRoot, "matlab-connection")).toBe(helper);
    expect(await resolveManagedPythonSpecPath(temporaryRoot)).toBe(packaged);
  });
});
