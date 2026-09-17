// @effect-diagnostics nodeBuiltinImport:off -- app-owned downloads and immutable environment assembly are a reviewed Node boundary.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import type { ComputeRuntimeError, ComputeToolkitId } from "@scientfactory/compute";
import { ExecutionRunId, type ExecutionProcessPort } from "@scientfactory/execution";
import {
  detectManagedRuntimeTarget,
  downloadManagedRuntime,
  managedRuntimeTargetKey,
  materializeManagedRuntimeArtifact,
  verifyManagedRuntimeChecksum,
  type ManagedRuntimeTarget,
} from "@scientfactory/provider-runtime";
import * as Duration from "effect/Duration";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { isolateManagedPythonPackages } from "./ManagedPythonPackageIsolation.ts";
import { managedPythonFileCheck } from "./ManagedPythonScientificChecks.ts";

import type {
  ManagedPythonEnvironmentDependencies,
  ManagedPythonProvisionInput,
  ManagedPythonProvisionProgress,
} from "./ManagedPythonEnvironment.ts";
import {
  managedPythonSpecificationDirectory,
  type ManagedPythonPurpose,
} from "./managed-python/specifications.ts";
import {
  buildProfile,
  checkReadiness,
  makePythonRuntimeAdapter,
  parseProbeOutput,
} from "./PythonRuntimeAdapter.ts";
import { assessPythonToolkits, PYTHON_TOOLKIT_EXTRAS } from "./PythonToolkitCatalog.ts";

export const MANAGED_PYTHON_VERSION = "3.14.7";
export const MANAGED_PYTHON_UV_VERSION = "0.12.15";
export const MANAGED_PYTHON_PROVISIONER_VERSION = `uv-${MANAGED_PYTHON_UV_VERSION}-shared-python-v1`;
export const MANAGED_PYTHON_TOOLKIT_REVISION = "scientific-python-2026-09-17.2";
export const MANAGED_PYTHON_LOCK_SHA256 =
  "b1470dc4f8d0ee92106504bc98f970c97f781d022686b3c90ae65cd28d121577";
export const MANAGED_PYTHON_PROJECT_SHA256 =
  "b7c6b99e2200e510c27ec6c9944d8bc2cd949fdcf37137080cab5f050d7cae2e";
const STAGED_MANAGED_PYTHON_DIRECTORY = "scient-managed-python";

const PROCESS_TIMEOUT = Duration.minutes(30);
const PROCESS_DRAIN_GRACE = Duration.seconds(3);
const OUTPUT_TAIL_BYTES = 64 * 1024;

class ManagedPythonProcessError extends Data.TaggedError("ManagedPythonProcessError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const REPRESENTATIVE_SCIENTIFIC_CHECK = [
  "import io, json",
  "import ipykernel, jupyter_client",
  "import matplotlib",
  'matplotlib.use("Agg")',
  "import matplotlib.pyplot as plt",
  "import nbformat",
  "import numpy as np",
  "import pandas as pd",
  "import plotly.graph_objects as go",
  "import openpyxl",
  "import seaborn as sns",
  "import statsmodels.api as sm",
  "import sympy",
  "from sklearn.linear_model import LinearRegression",
  "from scipy import stats",
  "x = np.arange(6, dtype=float)",
  'frame = pd.DataFrame({"x": x, "y": x ** 2})',
  "assert frame.y.sum() == 55.0",
  "assert abs(float(stats.zscore(x).mean())) < 1e-12",
  "figure, axis = plt.subplots()",
  'axis.plot(frame["x"], frame["y"])',
  "buffer = io.BytesIO()",
  'figure.savefig(buffer, format="png")',
  "plt.close(figure)",
  "assert len(buffer.getvalue()) > 100",
  "chart = go.Figure(data=go.Scatter(x=[1, 2], y=[3, 4]))",
  'assert chart.to_plotly_json()["data"][0]["type"] == "scatter"',
  "assert LinearRegression().fit([[0], [1]], [0, 1]).predict([[2]])[0] > 1.9",
  "assert sympy.diff(sympy.Symbol('x') ** 2).subs({'x': 3}) == 6",
  "assert sm.add_constant([1, 2]).shape == (2, 2)",
  "assert sns.color_palette(n_colors=3)",
  "assert openpyxl.Workbook().active.max_row == 1",
  'assert tuple(int(part) for part in nbformat.__version__.split(".")[:2]) >= (4, 2)',
].join("\n");

function representativeScientificCheck(toolkitIds: ReadonlyArray<ComputeToolkitId>): string {
  return [
    REPRESENTATIVE_SCIENTIFIC_CHECK,
    managedPythonFileCheck(toolkitIds),
    'print(json.dumps({"ok": True}))',
  ].join("\n");
}

export interface ManagedPythonUvArtifact {
  readonly assetName: string;
  readonly size: number;
  readonly sha256: string;
  readonly archiveFormat: "tar.gz" | "zip";
  readonly executablePath: string;
  readonly auxiliaryExecutablePath: string;
  readonly executableSha256: string;
  readonly auxiliaryExecutableSha256: string;
}

/** Resolve only server-reviewed Toolkit identities to locked uv extras. */
export function managedPythonExtrasForToolkits(
  toolkitIds: ReadonlyArray<ComputeToolkitId>,
): ReadonlyArray<string> {
  return toolkitIds.flatMap((toolkitId) => {
    const extra = PYTHON_TOOLKIT_EXTRAS[toolkitId];
    if (extra === undefined) {
      throw new Error(`Unknown Scientific Python Toolkit: ${toolkitId}.`);
    }
    return extra === null ? [] : [extra];
  });
}

const UV_ARTIFACTS: Readonly<Record<string, ManagedPythonUvArtifact>> = {
  "darwin-arm64": {
    assetName: "uv-aarch64-apple-darwin.tar.gz",
    size: 16_678_128,
    sha256: "dc304b9ed1b24174572290fba60ac3f6fe63c73a671f0439e62a91375841964d",
    archiveFormat: "tar.gz",
    executablePath: "uv-aarch64-apple-darwin/uv",
    auxiliaryExecutablePath: "uv-aarch64-apple-darwin/uvx",
    executableSha256: "c1f752966980dc37be8b6a90dcdcc314f689bbc82a2f86071712924f4be799b0",
    auxiliaryExecutableSha256: "498c13c7f6de8e1eb8f74b8fae0c5949d6f595d3a70dcc65de368edd1cf06e5c",
  },
  "darwin-x64": {
    assetName: "uv-x86_64-apple-darwin.tar.gz",
    size: 20_292_831,
    sha256: "e9ca61775532368fe518ab03e7a354c7ecab8ccb3c7d941c775fcc4a362b801b",
    archiveFormat: "tar.gz",
    executablePath: "uv-x86_64-apple-darwin/uv",
    auxiliaryExecutablePath: "uv-x86_64-apple-darwin/uvx",
    executableSha256: "3f808e3cc63f06a03861472b2431167d1062e2bf0bd71e7423a5d230cf103720",
    auxiliaryExecutableSha256: "c85556103b043f0397cb443588d422a565e73ffaddbb075764891827c76f26fd",
  },
  "linux-arm64-glibc": {
    assetName: "uv-aarch64-unknown-linux-gnu.tar.gz",
    size: 18_654_404,
    sha256: "0e9a3499b0587d449c9ff684c0160da607826e4af1cee220bc87f378702d3e08",
    archiveFormat: "tar.gz",
    executablePath: "uv-aarch64-unknown-linux-gnu/uv",
    auxiliaryExecutablePath: "uv-aarch64-unknown-linux-gnu/uvx",
    executableSha256: "e5495936943d447df4e0ffcbda60c8bb743829e31bc27e802eac9ae99293b56c",
    auxiliaryExecutableSha256: "4c54d360bb1a9b727c9dc16a91786449dd0a0db85f74f2aec9e88cc1ced0658c",
  },
  "linux-x64-glibc": {
    assetName: "uv-x86_64-unknown-linux-gnu.tar.gz",
    size: 19_443_011,
    sha256: "f97935763c04be3e692460a7aaeaaab8fc3b78fcf8b389da820b38ae7423a638",
    archiveFormat: "tar.gz",
    executablePath: "uv-x86_64-unknown-linux-gnu/uv",
    auxiliaryExecutablePath: "uv-x86_64-unknown-linux-gnu/uvx",
    executableSha256: "5d59bc45431db192c0a49a01c517041c3bd8778adb3fbc5195aaa025eec19e23",
    auxiliaryExecutableSha256: "c9faf31836f0a99906793db2192fb40fc3f3c8b5ec545a99a5ff3ce6acdc031e",
  },
  "linux-arm64-musl": {
    assetName: "uv-aarch64-unknown-linux-musl.tar.gz",
    size: 20_754_110,
    sha256: "93b801abb146e6431fb0434346a0162e65d3f0d1cd7360144d04c43488fd7f7d",
    archiveFormat: "tar.gz",
    executablePath: "uv-aarch64-unknown-linux-musl/uv",
    auxiliaryExecutablePath: "uv-aarch64-unknown-linux-musl/uvx",
    executableSha256: "b051754f46946ddf3dbec570ab22b05232eba16f28400ba09ba6419a1524903c",
    auxiliaryExecutableSha256: "fcc20db9b5f2563adc35525922b30853db78bab7c75dac68e95147e8140b4722",
  },
  "linux-x64-musl": {
    assetName: "uv-x86_64-unknown-linux-musl.tar.gz",
    size: 22_429_965,
    sha256: "999c0c3da986953e508985c3932d283d2c62eb167b4f8d81e79f565e34104959",
    archiveFormat: "tar.gz",
    executablePath: "uv-x86_64-unknown-linux-musl/uv",
    auxiliaryExecutablePath: "uv-x86_64-unknown-linux-musl/uvx",
    executableSha256: "85265222f25cf610272798247677805b0947dd5553e4e1aa2a8ce0a0c0ed7671",
    auxiliaryExecutableSha256: "3234da3760c062f31099e8bca6e21d28d4f5570119ff7a10a10382a10a6cf40f",
  },
  "win32-arm64": {
    assetName: "uv-aarch64-pc-windows-msvc.zip",
    size: 18_880_214,
    sha256: "a37c8e96cb1260488c8510b64c848533a3a82a2fdf9e905de7c2700ceebf6437",
    archiveFormat: "zip",
    executablePath: "uv.exe",
    auxiliaryExecutablePath: "uvx.exe",
    executableSha256: "cefb67f8ed94708f21601827c47bc7a94537211013c8f4b6e62f3734c3f6743b",
    auxiliaryExecutableSha256: "ba334adc36acfeb234a93538a2027bcaa408f3896de31f583ddf3a46e00eb663",
  },
  "win32-x64": {
    assetName: "uv-x86_64-pc-windows-msvc.zip",
    size: 17_578_593,
    sha256: "477bd99a84e34891f2bd4c9152ddeb74e971accccbc59c0f0301f11f08a32d46",
    archiveFormat: "zip",
    executablePath: "uv.exe",
    auxiliaryExecutablePath: "uvx.exe",
    executableSha256: "b0131eb55f112aee1836951ba96abec9c897b7bedd3f2fdebb19d710cfb636cd",
    auxiliaryExecutableSha256: "12fa21b9a137b045d5c093ada895e2eda8494741d658ab174bd28e082fd3200c",
  },
};

export function managedPythonSpecPathCandidates(
  directory: string,
  purpose: ManagedPythonPurpose = "python",
): ReadonlyArray<string> {
  const relativeDirectory = managedPythonSpecificationDirectory(purpose);
  const nested = relativeDirectory === "." ? [] : [relativeDirectory];
  return [
    NodePath.join(directory, "managed-python", ...nested),
    NodePath.join(directory, STAGED_MANAGED_PYTHON_DIRECTORY, ...nested),
  ];
}

export async function resolveManagedPythonSpecPath(
  directory: string,
  purpose: ManagedPythonPurpose = "python",
): Promise<string> {
  const candidates = managedPythonSpecPathCandidates(directory, purpose);
  const noun =
    purpose === "matlab-connection"
      ? "MATLAB connection helper specification"
      : "managed Python specification";
  for (const candidate of candidates) {
    const present = await Promise.all(
      ["pyproject.toml", "uv.lock"].map((file) =>
        NodeFSP.stat(NodePath.join(candidate, file)).then(
          (stat) => stat.isFile(),
          () => false,
        ),
      ),
    );
    if (present.every(Boolean)) return candidate;
  }
  throw new Error(`Unable to find the ${noun}. Looked in: ${candidates.join(", ")}.`);
}

export function managedPythonUvArtifactForTarget(
  target: ManagedRuntimeTarget,
): ManagedPythonUvArtifact {
  const artifact = UV_ARTIFACTS[managedRuntimeTargetKey(target)];
  if (artifact === undefined) {
    throw new Error(`Scientific Python is not available for ${managedRuntimeTargetKey(target)}.`);
  }
  return artifact;
}

function appendTail(current: string, next: string): string {
  const combined = current + next;
  if (Buffer.byteLength(combined, "utf8") <= OUTPUT_TAIL_BYTES) return combined;
  return combined.slice(-OUTPUT_TAIL_BYTES);
}

export function runOwnedProcess(
  processes: ExecutionProcessPort,
  input: {
    readonly runId: string;
    readonly executable: string;
    readonly args: ReadonlyArray<string>;
    readonly cwd: string;
    readonly environment: Readonly<Record<string, string>>;
    readonly stdoutOnly?: boolean;
  },
): Effect.Effect<string, ManagedPythonProcessError> {
  return Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* processes
        .start({
          runId: ExecutionRunId.make(input.runId),
          executable: input.executable,
          args: input.args,
          cwd: input.cwd,
          environment: input.environment,
          extendEnv: false,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new ManagedPythonProcessError({
                message: `Unable to start ${input.executable}.`,
                cause,
              }),
          ),
        );
      const outputRef = yield* Ref.make("");
      const stdoutRef = yield* Ref.make("");
      const drain = yield* handle.output.pipe(
        Stream.runForEach((chunk) =>
          Effect.gen(function* () {
            yield* Ref.update(outputRef, (tail) => appendTail(tail, chunk.text));
            if (input.stdoutOnly && chunk.stream === "stdout")
              yield* Ref.update(stdoutRef, (tail) => appendTail(tail, chunk.text));
          }),
        ),
        Effect.catchCause((cause) =>
          Effect.logDebug("managed Python process output ended early", { cause }),
        ),
        Effect.forkScoped,
      );
      const exitCode = yield* handle.exitCode.pipe(
        Effect.mapError(
          (cause) =>
            new ManagedPythonProcessError({
              message: `Unable to wait for ${input.executable}.`,
              cause,
            }),
        ),
        Effect.timeoutOption(PROCESS_TIMEOUT),
        Effect.onInterrupt(() => handle.cancel.pipe(Effect.ignoreCause())),
      );
      if (Option.isNone(exitCode)) {
        yield* handle.cancel.pipe(Effect.ignoreCause());
      }
      yield* Fiber.join(drain).pipe(
        Effect.timeoutOption(PROCESS_DRAIN_GRACE),
        Effect.ignoreCause(),
      );
      const output = yield* Ref.get(outputRef);
      if (Option.isNone(exitCode)) {
        return yield* new ManagedPythonProcessError({
          message: `${input.executable} did not finish within 30 minutes.`,
        });
      }
      if (exitCode.value !== 0) {
        const detail = output.trim().slice(-4096);
        return yield* new ManagedPythonProcessError({
          message: `${input.executable} exited with code ${String(exitCode.value)}${detail.length > 0 ? `: ${detail}` : "."}`,
        });
      }
      return input.stdoutOnly ? yield* Ref.get(stdoutRef) : output;
    }),
  );
}

export function managedPythonProvisioningEnvironment(
  base: Readonly<Record<string, string>>,
  input: {
    readonly targetRoot: string;
    readonly projectRoot: string;
    readonly cacheRoot?: string;
    readonly interpreterRoot?: string;
  },
): Record<string, string> {
  const environment = Object.fromEntries(
    Object.entries(base).filter(([key]) => {
      const canonical = key.toUpperCase();
      return (
        !["UV_", "PIP_", "POETRY_", "PYENV_", "CONDA_"].some((prefix) =>
          canonical.startsWith(prefix),
        ) && canonical !== "VIRTUAL_ENV"
      );
    }),
  );
  return {
    ...environment,
    PYTHONUTF8: "1",
    PYTHONUNBUFFERED: "1",
    UV_CACHE_DIR: input.cacheRoot ?? NodePath.join(input.targetRoot, ".cache"),
    UV_MANAGED_PYTHON: "1",
    UV_NO_CONFIG: "1",
    UV_NO_PROGRESS: "1",
    UV_PROJECT: input.projectRoot,
    UV_PROJECT_ENVIRONMENT: NodePath.join(input.targetRoot, "environment"),
    UV_PYTHON_INSTALL_DIR: input.interpreterRoot ?? NodePath.join(input.targetRoot, "python"),
    UV_SYSTEM_CERTS: "1",
  };
}

async function verifySpecification(
  specDirectory: string,
  recipe?: ManagedPythonProvisionerOptions["recipe"],
): Promise<void> {
  await Promise.all([
    verifyManagedRuntimeChecksum(NodePath.join(specDirectory, "uv.lock"), {
      algorithm: "sha256",
      digest: recipe?.lockSha256 ?? MANAGED_PYTHON_LOCK_SHA256,
    }),
    verifyManagedRuntimeChecksum(NodePath.join(specDirectory, "pyproject.toml"), {
      algorithm: "sha256",
      digest: recipe?.projectSha256 ?? MANAGED_PYTHON_PROJECT_SHA256,
    }),
  ]);
}

interface ManagedPythonProvisionerBase {
  readonly computeDir: string;
  readonly specDirectory: string;
  readonly processes: ExecutionProcessPort;
  readonly environment: Readonly<Record<string, string>>;
  readonly platform: NodeJS.Platform;
  readonly arch: NodeJS.Architecture;
  /** Injectable only for isolated artifact-integrity tests. */
  readonly uvArtifact?: ManagedPythonUvArtifact;
}

/** A reviewed recipe supplies its own verifier; Scientific Python uses its adapter. */
export type ManagedPythonProvisionerOptions = ManagedPythonProvisionerBase &
  (
    | {
        readonly spawnProbe: (executable: string) => Effect.Effect<string, ComputeRuntimeError>;
        readonly recipe?: undefined;
      }
    | {
        readonly recipe: {
          readonly lockSha256: string;
          readonly projectSha256: string;
          readonly verify: ManagedPythonEnvironmentDependencies["verify"];
        };
      }
  );

export function makeManagedPythonProvisioner(
  options: ManagedPythonProvisionerOptions,
): Pick<ManagedPythonEnvironmentDependencies, "provision" | "verify"> {
  const platform = options.platform;
  const target = detectManagedRuntimeTarget({ platform, arch: options.arch });
  const artifact = options.uvArtifact ?? managedPythonUvArtifactForTarget(target);
  let runSequence = 0;
  const nextRunId = (purpose: string): string => {
    runSequence += 1;
    return `scient-managed-python-${purpose}-${String(runSequence)}`;
  };

  const run = (
    executable: string,
    args: ReadonlyArray<string>,
    cwd: string,
    environment: Readonly<Record<string, string>>,
    signal: AbortSignal,
    purpose: string,
  ): Promise<string> => {
    signal.throwIfAborted();
    const started = performance.now();
    return Effect.runPromise(
      runOwnedProcess(options.processes, {
        runId: nextRunId(purpose),
        executable,
        args,
        cwd,
        environment,
        stdoutOnly: purpose === "cache-size" || purpose === "python-find",
      }),
      { signal },
    ).finally(() => {
      Effect.runSync(
        Effect.logDebug("Managed Python phase finished", {
          phase: purpose,
          durationMs: Math.round(performance.now() - started),
          cancelled: signal.aborted,
        }),
      );
    });
  };

  const smokeUv = async (executable: string, signal: AbortSignal): Promise<void> => {
    const output = await run(
      executable,
      ["--version"],
      options.specDirectory,
      options.environment,
      signal,
      "uv-smoke",
    );
    if (!output.trim().startsWith(`uv ${MANAGED_PYTHON_UV_VERSION}`)) {
      throw new Error(`The managed installer reported an unexpected version: ${output.trim()}.`);
    }
  };

  const verifyUvPayload = async (root: string): Promise<void> => {
    const entries = [
      [artifact.executablePath, artifact.executableSha256],
      [artifact.auxiliaryExecutablePath, artifact.auxiliaryExecutableSha256],
    ] as const;
    await Promise.all(
      entries.map(async ([relativePath, sha256]) => {
        const executable = NodePath.join(root, relativePath);
        const stat = await NodeFSP.lstat(executable);
        if (!stat.isFile()) {
          throw new Error("The cached managed installer contains a non-file executable.");
        }
        await verifyManagedRuntimeChecksum(executable, {
          algorithm: "sha256",
          digest: sha256,
        });
      }),
    );
  };

  const ensureUv = async (
    signal: AbortSignal,
    onProgress?: ((progress: ManagedPythonProvisionProgress) => void) | undefined,
  ): Promise<string> => {
    const targetKey = managedRuntimeTargetKey(target);
    const versionRoot = NodePath.join(
      options.computeDir,
      "tooling",
      "uv",
      MANAGED_PYTHON_UV_VERSION,
    );
    for (const directory of [
      options.computeDir,
      NodePath.join(options.computeDir, "tooling"),
      NodePath.join(options.computeDir, "tooling", "uv"),
      versionRoot,
    ]) {
      await NodeFSP.mkdir(directory, { recursive: true, mode: 0o700 });
      if (!(await NodeFSP.lstat(directory)).isDirectory()) {
        throw new Error("The managed installer cache must be an app-owned directory, not a link.");
      }
    }
    const finalRoot = NodePath.join(versionRoot, targetKey);
    const finalRootIsDirectory = await NodeFSP.lstat(finalRoot).then(
      (stat) => stat.isDirectory(),
      (cause: NodeJS.ErrnoException) => {
        if (cause.code === "ENOENT") return null;
        throw cause;
      },
    );
    if (finalRootIsDirectory === false) {
      throw new Error("The managed installer cache must be an app-owned directory, not a link.");
    }
    const finalExecutable = NodePath.join(finalRoot, artifact.executablePath);
    const existing = await NodeFSP.lstat(finalExecutable).then(
      (stat) => stat.isFile(),
      () => false,
    );
    if (existing) {
      try {
        await verifyUvPayload(finalRoot);
        await smokeUv(finalExecutable, signal);
        return finalExecutable;
      } catch {
        // Cancelling validation does not establish that the cached installer is corrupt.
        signal.throwIfAborted();
        const corrupt = NodePath.join(
          versionRoot,
          `${targetKey}.invalid-${NodeCrypto.randomUUID()}`,
        );
        await NodeFSP.rename(finalRoot, corrupt).catch(() => undefined);
        await NodeFSP.rm(corrupt, { recursive: true, force: true }).catch(() => undefined);
      }
    }
    const stagingRoot = NodePath.join(
      versionRoot,
      `${targetKey}.installing-${NodeCrypto.randomUUID()}`,
    );
    const archivePath = NodePath.join(stagingRoot, artifact.assetName);
    const payloadRoot = NodePath.join(stagingRoot, "payload");
    await NodeFSP.mkdir(stagingRoot, { recursive: false, mode: 0o700 });
    try {
      onProgress?.({ phase: "downloading", downloadedBytes: 0, totalBytes: artifact.size });
      await downloadManagedRuntime({
        url: `https://github.com/astral-sh/uv/releases/download/${MANAGED_PYTHON_UV_VERSION}/${artifact.assetName}`,
        destination: archivePath,
        allowedHosts: [
          "github.com",
          "objects.githubusercontent.com",
          "release-assets.githubusercontent.com",
        ],
        expectedSize: artifact.size,
        signal,
        onProgress: (downloadedBytes, totalBytes) =>
          onProgress?.({ phase: "downloading", downloadedBytes, totalBytes }),
      });
      await verifyManagedRuntimeChecksum(archivePath, {
        algorithm: "sha256",
        digest: artifact.sha256,
      });
      const stagedExecutable = await materializeManagedRuntimeArtifact({
        archivePath,
        archiveFormat: artifact.archiveFormat,
        destination: payloadRoot,
        executablePath: artifact.executablePath,
        auxiliaryExecutablePaths: [artifact.auxiliaryExecutablePath],
        platform,
        extractionLimits: { maxEntries: 8, maxExpandedBytes: 96 * 1024 * 1024 },
        signal,
      });
      await verifyUvPayload(payloadRoot);
      await smokeUv(stagedExecutable, signal);
      await NodeFSP.rename(payloadRoot, finalRoot).catch(async (cause) => {
        const winner = await NodeFSP.stat(finalExecutable).then(
          (stat) => stat.isFile(),
          () => false,
        );
        if (!winner) throw cause;
      });
      await verifyUvPayload(finalRoot);
      await smokeUv(finalExecutable, signal);
      return finalExecutable;
    } finally {
      await NodeFSP.rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  };

  const provision = async (input: ManagedPythonProvisionInput) => {
    const extras = managedPythonExtrasForToolkits(input.toolkitIds);
    await verifySpecification(options.specDirectory, options.recipe);
    const uv = await ensureUv(input.signal, input.onProgress);
    // Reuse the pinned installer's CPython build; package environments stay private.
    const cacheRoot = NodePath.join(options.computeDir, "cache", "python");
    const interpretersRoot = NodePath.join(options.computeDir, "interpreters", "python");
    const defaultStore = `uv-${MANAGED_PYTHON_UV_VERSION}`;
    const previousStore = input.interpreterRelativePath?.split(NodePath.sep)[0];
    // Repair must not reuse a damaged interpreter, or replace one under live sessions.
    // Later Toolkit changes reuse the repaired store through its verified receipt.
    const reusableStore =
      previousStore === defaultStore ||
      (previousStore?.startsWith(`${defaultStore}-repair-`) &&
        /^[a-zA-Z0-9.-]+$/.test(previousStore))
        ? previousStore
        : defaultStore;
    const interpreterRoot = NodePath.join(
      interpretersRoot,
      input.freshInterpreter ? `${defaultStore}-repair-${NodeCrypto.randomUUID()}` : reusableStore,
    );
    for (const directory of [
      options.computeDir,
      NodePath.dirname(cacheRoot),
      cacheRoot,
      NodePath.dirname(interpretersRoot),
      interpretersRoot,
      interpreterRoot,
    ]) {
      await NodeFSP.mkdir(directory, { recursive: true, mode: 0o700 });
      if (!(await NodeFSP.lstat(directory)).isDirectory()) {
        throw new Error("The managed Python cache must be an app-owned directory, not a link.");
      }
    }
    const projectRoot = NodePath.join(input.targetRoot, "project");
    await NodeFSP.mkdir(projectRoot, { recursive: false, mode: 0o700 });
    await Promise.all(
      ["pyproject.toml", "uv.lock"].map((file) =>
        NodeFSP.copyFile(
          NodePath.join(options.specDirectory, file),
          NodePath.join(projectRoot, file),
        ),
      ),
    );
    const environment = managedPythonProvisioningEnvironment(options.environment, {
      targetRoot: input.targetRoot,
      projectRoot,
      cacheRoot,
      interpreterRoot,
    });
    const maintainCache = async () => {
      const bytes = (
        await run(
          uv,
          ["cache", "size", "--no-config", "--color", "never"],
          projectRoot,
          environment,
          input.signal,
          "cache-size",
        )
      ).trim();
      if (!/^\d+$/.test(bytes))
        throw new Error("The managed installer returned an invalid cache size.");
      // A retention ceiling, not a quota on in-flight downloads. uv owns locking
      // and eviction; never remove its entries directly or touch the user's cache.
      if (Number(bytes) > 2 * 1024 ** 3) {
        await run(
          uv,
          ["cache", "clean", "--no-config", "--color", "never"],
          projectRoot,
          { ...environment, UV_LOCK_TIMEOUT: "5" },
          input.signal,
          "cache-clean",
        );
      }
    };
    await maintainCache();
    input.onProgress?.({
      phase: "installing-python",
      downloadedBytes: null,
      totalBytes: null,
    });
    await run(
      uv,
      [
        "python",
        "install",
        input.pythonVersion,
        "--managed-python",
        "--no-bin",
        "--no-registry",
        "--no-config",
        "--no-progress",
        "--system-certs",
        "--color",
        "never",
      ],
      projectRoot,
      environment,
      input.signal,
      "python-install",
    );
    const interpreter = (
      await run(
        uv,
        [
          "python",
          "find",
          input.pythonVersion,
          "--managed-python",
          "--no-python-downloads",
          "--no-config",
        ],
        projectRoot,
        environment,
        input.signal,
        "python-find",
      )
    ).trim();
    const canonicalInterpreters = await NodeFSP.realpath(interpretersRoot);
    const canonicalInterpreter = await NodeFSP.realpath(interpreter);
    const interpreterRelativePath = NodePath.relative(canonicalInterpreters, canonicalInterpreter);
    if (
      !interpreterRelativePath ||
      interpreterRelativePath.startsWith("..") ||
      NodePath.isAbsolute(interpreterRelativePath)
    )
      throw new Error("The installer selected Python outside Scient's private interpreter store.");
    input.onProgress?.({
      phase: "installing-packages",
      downloadedBytes: null,
      totalBytes: null,
    });
    await run(
      uv,
      [
        "sync",
        "--locked",
        "--no-dev",
        ...extras.flatMap((extra) => ["--extra", extra]),
        "--no-install-project",
        "--managed-python",
        "--no-python-downloads",
        "--no-build",
        "--no-sources",
        "--link-mode",
        "clone",
        "--python",
        interpreter,
        "--project",
        projectRoot,
        "--no-config",
        "--no-progress",
        "--system-certs",
        "--color",
        "never",
      ],
      projectRoot,
      environment,
      input.signal,
      "package-install",
    );
    const isolationStarted = performance.now();
    await isolateManagedPythonPackages(
      NodePath.join(input.targetRoot, "environment"),
      input.signal,
    );
    Effect.runSync(
      Effect.logDebug("Managed Python phase finished", {
        phase: "package-isolation",
        durationMs: Math.round(performance.now() - isolationStarted),
      }),
    );
    await maintainCache();
    return {
      interpreterRelativePath,
      executableRelativePath:
        platform === "win32"
          ? NodePath.join("environment", "Scripts", "python.exe")
          : NodePath.join("environment", "bin", "python"),
    };
  };

  const verify = async (input: {
    readonly executable: string;
    readonly toolkitIds: ReadonlyArray<ComputeToolkitId>;
    readonly pythonVersion: string;
    readonly signal: AbortSignal;
    readonly onProgress?: ((progress: ManagedPythonProvisionProgress) => void) | undefined;
  }): Promise<void> => {
    input.onProgress?.({ phase: "verifying", downloadedBytes: null, totalBytes: null });
    if (options.recipe !== undefined) return options.recipe.verify(input);
    const stdout = await Effect.runPromise(options.spawnProbe(input.executable), {
      signal: input.signal,
    });
    const probe = parseProbeOutput(stdout);
    if (probe.version !== input.pythonVersion) {
      throw new Error(
        `Scientific Python reported ${probe.version}; expected exactly ${input.pythonVersion}.`,
      );
    }
    const readiness = checkReadiness(probe);
    if (readiness.readiness !== "ready") {
      throw new Error(`Scientific Python is missing: ${readiness.missing.join(", ")}.`);
    }
    const adapter = makePythonRuntimeAdapter(options.spawnProbe, "/unused-managed-python-bridge");
    const verification = await Effect.runPromise(
      adapter.verify({
        profile: buildProfile(probe, "managed"),
        cwd: options.specDirectory,
        environment: options.environment,
      }),
      { signal: input.signal },
    );
    const assessments = assessPythonToolkits(verification);
    for (const toolkitId of input.toolkitIds) {
      const assessment = assessments.find((candidate) => candidate.toolkitId === toolkitId);
      if (assessment?.readiness !== "ready") {
        throw new Error(
          `Scientific Python did not satisfy ${toolkitId}: ${assessment?.missingRequirements.join(", ") ?? "Toolkit not found"}.`,
        );
      }
    }
    await run(
      input.executable,
      ["-I", "-c", representativeScientificCheck(input.toolkitIds)],
      options.specDirectory,
      options.environment,
      input.signal,
      "scientific-check",
    );
  };

  return { provision, verify };
}
