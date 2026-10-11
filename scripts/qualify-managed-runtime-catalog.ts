#!/usr/bin/env node

// @effect-diagnostics nodeBuiltinImport:off globalTimers:off -- Native CI qualification intentionally exercises provider downloads in an isolated temporary runtime root; the child process it supervises, and its cancellation grace timer, live outside Effect.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";

import {
  ManagedAntigravityRuntime,
  ManagedClaudeRuntime,
  ManagedCodexRuntime,
  ManagedCursorRuntime,
  ManagedDroidRuntime,
  ManagedGrokRuntime,
  ManagedOmpRuntime,
  ManagedPiRuntime,
  ManagedScientAgentRuntime,
  managedRuntimeSmokeEnvironment,
  smokeManagedRuntimeExecutable,
  detectManagedRuntimeTarget,
  hydrateManagedRuntimeArtifact,
  managedRuntimeTargetKey,
  runtimeFilesystem,
  resolveReviewedAntigravityArtifact,
  resolveReviewedClaudeArtifact,
  resolveReviewedCodexArtifact,
  resolveReviewedCursorArtifact,
  resolveReviewedDroidArtifact,
  resolveReviewedGrokArtifact,
  resolveReviewedOmpArtifact,
  resolveReviewedPiArtifact,
  resolveScientAgentArtifactPolicy,
  type ManagedProviderRuntime,
  type ManagedRuntimeArtifactPolicy,
  type ManagedRuntimeProvider,
  type ManagedProviderRuntimeQualificationInput,
} from "@scientfactory/provider-runtime";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";

import {
  readManagedRuntimeCatalog,
  validateManagedRuntimeCandidate,
} from "./lib/managed-runtime-catalog.ts";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const provider = argument("--provider") as ManagedRuntimeProvider | undefined;
const runPiLiveTests = process.argv.includes("--pi-live-tests");
const runDroidLiveTests = process.argv.includes("--droid-live-tests");
const catalogPath = NodePath.resolve(
  argument("--catalog") ??
    "apps/server/src/scient/providerLifecycle/bundled-managed-runtime-catalog.json",
);
if (!provider) throw new Error("--provider is required.");
if (runPiLiveTests && provider !== "pi") {
  throw new Error("--pi-live-tests is valid only for Pi qualification.");
}
if (runDroidLiveTests && provider !== "droid") {
  throw new Error("--droid-live-tests is valid only for Droid qualification.");
}

/** Runs live suites, one file at a time, against the binary named in `environment`. */
async function runLiveTests(input: {
  readonly label: string;
  readonly tests: ReadonlyArray<string>;
  readonly environment: Readonly<Record<string, string>>;
  readonly platform: NodeJS.Platform;
}): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = NodeChildProcess.spawn(
      "vp",
      ["test", "run", "--no-file-parallelism", ...input.tests],
      {
        cwd: process.cwd(),
        env: { ...process.env, ...input.environment },
        // Windows cannot execute a package-manager .cmd shim directly through spawn.
        // The shell is needed only to resolve the fixed `vp` command; all arguments are static.
        shell: input.platform === "win32",
        stdio: "inherit",
        windowsHide: true,
      },
    );
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(
            `${input.label} failed${signal ? ` with signal ${signal}` : ` with exit code ${String(code)}`}.`,
          ),
        );
    });
  });
}

const verifyPiIntegration = (binary: string, version: string, platform: NodeJS.Platform) =>
  runLiveTests({
    label: "Pi integration qualification",
    tests: [
      "apps/server/src/provider/pi/PiCustomModels.live.test.ts",
      "apps/server/src/provider/pi/PiNativeProvider.live.test.ts",
      "apps/server/src/provider/pi/PiReasoning.live.test.ts",
      "apps/server/src/provider/pi/PiRuntime.live.test.ts",
      "apps/server/src/provider/pi/PiXai.live.test.ts",
    ],
    environment: { SCIENT_PI_TEST_BINARY: binary, SCIENT_PI_TEST_VERSION: version },
    platform,
  });

/**
 * Droid is published only after the installed binary speaks the protocol the
 * app depends on: ACP startup, the session controls (model, autonomy level,
 * reasoning effort), a turn, and the guards around custom-model keys,
 * background generation and request loops. Every request goes to a local stub
 * with a fixture key and a private HOME: no Factory account and no network.
 */
const verifyDroidProtocol = (binary: string, version: string, platform: NodeJS.Platform) =>
  runLiveTests({
    label: "Droid protocol qualification",
    tests: [
      "apps/server/src/provider/droid/DroidRuntime.live.test.ts",
      "apps/server/src/provider/droid/DroidReasoning.live.test.ts",
      "apps/server/src/provider/droid/DroidProviderStatus.live.test.ts",
      "apps/server/src/provider/droid/DroidBackgroundGeneration.live.test.ts",
      "apps/server/src/provider/droid/DroidKeyIsolation.live.test.ts",
      "apps/server/src/provider/droid/DroidRequestLimits.live.test.ts",
    ],
    environment: { SCIENT_DROID_TEST_BINARY: binary, SCIENT_DROID_TEST_VERSION: version },
    platform,
  });

/**
 * Every process below `root`, read from `ps` (POSIX); children before their own
 * children. `undefined` when the listing failed: that is not an empty tree.
 */
function posixDescendants(root: number): number[] | undefined {
  const listing = NodeChildProcess.spawnSync("ps", ["-A", "-o", "pid=,ppid="], {
    encoding: "utf8",
  });
  if (listing.error || listing.status !== 0 || !listing.stdout) return undefined;
  const children = new Map<number, number[]>();
  for (const line of (listing.stdout ?? "").split("\n")) {
    const [pid, ppid] = line.trim().split(/\s+/u).map(Number);
    if (!pid || !ppid) continue;
    children.set(ppid, [...(children.get(ppid) ?? []), pid]);
  }
  const found: number[] = [];
  const queue = [...(children.get(root) ?? [])];
  while (queue.length > 0) {
    const pid = queue.shift()!;
    found.push(pid);
    queue.push(...(children.get(pid) ?? []));
  }
  return found;
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Ends `root` and every process below it, and resolves to whether they are all
 * known to have exited (waiting up to 10 seconds). On POSIX the agent runs in
 * its own process group, so killing the supervisor alone would leave it
 * running: the tree is read first, because orphans lose their parent link once
 * the supervisor dies. A tree that could not be read is not known to have ended.
 */
async function terminateProcessTree(root: number): Promise<boolean> {
  if (HostProcess.Platform.defaultValue() === "win32") {
    const result = NodeChildProcess.spawnSync("taskkill", ["/pid", String(root), "/T", "/F"], {
      windowsHide: true,
    });
    return !result.error && result.status === 0;
  }
  const descendants = posixDescendants(root);
  const tree = [...(descendants ?? []), root];
  for (const pid of tree) {
    try {
      process.kill(-pid, "SIGKILL"); // the group it leads, if any
    } catch {}
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
  for (let waited = 0; waited < 100 && tree.some(isRunning); waited += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return descendants !== undefined && !tree.some(isRunning);
}

/**
 * Oh My Pi is published only after the installed binary completes the app's
 * managed-activation check: the RPC v2 handshake, its version, and
 * `get_state`. The check lives with the server code that clients run, so it
 * needs the server workspace dependencies installed.
 */
async function verifyRpc(
  provider: "omp" | "scient",
  binary: string,
  version: string,
  signal?: AbortSignal,
): Promise<void> {
  const script =
    provider === "scient"
      ? "apps/server/scripts/qualifyScientAgentManagedRuntime.ts"
      : "apps/server/scripts/qualify-omp-rpc.ts";
  const cancellation =
    provider === "scient"
      ? AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(90_000)])
      : undefined;
  cancellation?.throwIfAborted();
  // The parent owns the qualification's private home, so it is removed however
  // the child ends, including a forced termination that skips its own cleanup.
  const home =
    provider === "scient"
      ? await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-agent-rpc-qualification-"))
      : undefined;
  // Set when the tree had to be ended.
  let treeEnded: Promise<boolean> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      const child = NodeChildProcess.spawn(
        process.execPath,
        [script, "--binary", binary, "--version", version, ...(home ? ["--cwd", home] : [])],
        {
          cwd: process.cwd(),
          env: process.env,
          // The IPC channel carries cancellation: Windows has no SIGTERM, and
          // child.kill() there ends the process without running its cleanup.
          stdio: home ? ["inherit", "inherit", "inherit", "ipc"] : "inherit",
          windowsHide: true,
        },
      );
      let failure: unknown;
      let forced: ReturnType<typeof setTimeout> | undefined;
      const cancel = () => {
        failure = cancellation?.reason;
        // Ask first: the Scient CLI interrupts its Effect, which closes the RPC
        // child tree. If it has not exited after a grace period, end the tree.
        if (child.connected) child.send({ type: "cancel" });
        else child.kill("SIGTERM");
        forced = setTimeout(() => {
          if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined)
            return;
          treeEnded = terminateProcessTree(child.pid);
        }, 15_000);
      };
      cancellation?.addEventListener("abort", cancel, { once: true });
      if (cancellation?.aborted) cancel();
      child.once("error", (cause) => {
        failure = cause;
      });
      child.once("close", (code, exitSignal) => {
        cancellation?.removeEventListener("abort", cancel);
        if (forced) clearTimeout(forced);
        if (failure !== undefined) reject(failure);
        else if (code === 0) resolve();
        else
          reject(
            new Error(
              `${provider} RPC qualification failed${exitSignal ? ` with signal ${exitSignal}` : ` with exit code ${String(code)}`}.`,
            ),
          );
      });
    });
  } finally {
    // Removed only once the tree is known to have exited; never under an agent
    // that may still be running.
    const ended = (await treeEnded) ?? true;
    if (home && ended) await NodeFSP.rm(home, { recursive: true, force: true });
    else if (home) {
      process.stderr.write(
        `Left ${home} in place: the qualification's processes could not be confirmed to have exited.\n`,
      );
    }
  }
}

const providerFactories: Readonly<
  Record<
    ManagedRuntimeProvider,
    {
      readonly policy: (
        target: ReturnType<typeof detectManagedRuntimeTarget>,
      ) => ManagedRuntimeArtifactPolicy | undefined;
      readonly runtime: (baseDir: string) => ManagedProviderRuntime;
    }
  >
> = {
  codex: {
    policy: resolveReviewedCodexArtifact,
    runtime: (baseDir) => new ManagedCodexRuntime(baseDir),
  },
  claudeAgent: {
    policy: resolveReviewedClaudeArtifact,
    runtime: (baseDir) => new ManagedClaudeRuntime(baseDir),
  },
  antigravity: {
    policy: resolveReviewedAntigravityArtifact,
    runtime: (baseDir) => new ManagedAntigravityRuntime(baseDir),
  },
  cursor: {
    policy: resolveReviewedCursorArtifact,
    runtime: (baseDir) => new ManagedCursorRuntime(baseDir),
  },
  droid: {
    policy: resolveReviewedDroidArtifact,
    runtime: (baseDir) => new ManagedDroidRuntime(baseDir),
  },
  grok: {
    policy: resolveReviewedGrokArtifact,
    runtime: (baseDir) => new ManagedGrokRuntime(baseDir),
  },
  pi: {
    policy: resolveReviewedPiArtifact,
    runtime: (baseDir) => new ManagedPiRuntime(baseDir),
  },
  omp: {
    policy: resolveReviewedOmpArtifact,
    runtime: (baseDir) => new ManagedOmpRuntime(baseDir),
  },
  scient: {
    policy: resolveScientAgentArtifactPolicy,
    runtime: (baseDir) =>
      new ManagedScientAgentRuntime(baseDir, {
        // This script remains in the scripts workspace. RPC qualification runs
        // through the server CLI below; even the earlier identity smoke needs
        // a private home because native initialization can create state.
        smoke: async (executable, args, name, environment, options) => {
          const home = await NodeFSP.mkdtemp(NodePath.join(baseDir, "smoke-home-"));
          try {
            await smokeManagedRuntimeExecutable(
              executable,
              args,
              name,
              {
                ...managedRuntimeSmokeEnvironment(process.env),
                ...environment,
                HOME: home,
                USERPROFILE: home,
                APPDATA: NodePath.join(home, "AppData", "Roaming"),
                LOCALAPPDATA: NodePath.join(home, "AppData", "Local"),
                SCIENT_AGENT_ROOT: NodePath.join(home, "scient-agent"),
              },
              { ...options, cwd: home },
            );
          } finally {
            await NodeFSP.rm(home, { recursive: true, force: true });
          }
        },
      }),
  },
};

const target = await Effect.runPromise(
  Effect.gen(function* () {
    return detectManagedRuntimeTarget({
      platform: yield* HostProcess.Platform,
      arch: yield* HostProcess.Architecture,
    });
  }),
);
const targetKey = managedRuntimeTargetKey(target);
const factory = providerFactories[provider];
const policy = factory.policy(target);
if (!policy) throw new Error(`${provider} does not support native CI target ${targetKey}.`);

const catalog = readManagedRuntimeCatalog(
  JSON.parse(await NodeFSP.readFile(catalogPath, "utf8")),
  provider,
);
const release = validateManagedRuntimeCandidate(catalog, provider);
const artifactData = release.artifacts[targetKey];
if (!artifactData) {
  throw new Error(`${provider} catalog does not contain approved native target ${targetKey}.`);
}
const artifact = hydrateManagedRuntimeArtifact(policy, {
  provider,
  version: release.version,
  ...(release.supersedes ? { supersedes: release.supersedes } : {}),
  target,
  ...artifactData,
  catalogRevision: [
    "managed-runtime",
    provider,
    `contract-${release.contractRevision}`,
    release.version,
    targetKey,
    artifactData.checksum.algorithm,
    artifactData.checksum.digest,
  ].join(":"),
});
if (!artifact) throw new Error(`${provider} ${targetKey} violates app-owned runtime policy.`);

process.stdout.write(
  `Qualifying ${provider} ${artifact.version} on ${targetKey}, contract ${release.contractRevision}.\n`,
);

const root = await NodeFSP.mkdtemp(
  NodePath.join(NodeOS.tmpdir(), `scient-${provider}-qualification-`),
);
let qualificationFailure: unknown;
try {
  const runtime = factory.runtime(root);
  const qualification =
    provider === "scient"
      ? {
          qualify: ({
            executablePath,
            artifact: installed,
            signal,
          }: ManagedProviderRuntimeQualificationInput) =>
            verifyRpc("scient", executablePath, installed.version, signal),
        }
      : {};
  await runtime.install({ artifact, signal: AbortSignal.timeout(15 * 60_000), ...qualification });
  const status = await runtime.status(artifact);
  if (!status.installed || !status.selected || status.activeVersion !== artifact.version) {
    throw new Error(`${provider} ${targetKey} did not activate the qualified release.`);
  }
  if (runPiLiveTests) {
    await verifyPiIntegration(runtime.launchPath(artifact), artifact.version, target.platform);
  }
  if (runDroidLiveTests) {
    await verifyDroidProtocol(status.launchPath, artifact.version, target.platform);
  }
  if (provider === "omp") await verifyRpc(provider, status.launchPath, artifact.version);
  if (process.argv.includes("--repair")) {
    await runtime.install({ artifact, signal: AbortSignal.timeout(15 * 60_000), ...qualification });
    const repaired = await runtime.status(artifact);
    if (!repaired.installed || !repaired.selected || repaired.activeVersion !== artifact.version) {
      throw new Error(`${provider} ${targetKey} did not repair the qualified release.`);
    }
    if (provider === "omp") await verifyRpc(provider, repaired.launchPath, artifact.version);
  }
  await runtime.remove();
  const removed = await runtime.status(artifact);
  if (removed.installed || removed.selected) {
    throw new Error(`${provider} ${targetKey} did not cleanly remove the qualification runtime.`);
  }
  process.stdout.write(
    `${provider} ${artifact.version} passed native ${targetKey} qualification.\n`,
  );
} catch (cause) {
  qualificationFailure = cause;
  throw cause;
} finally {
  await runtimeFilesystem.remove(root).catch((cleanupFailure: unknown) => {
    if (qualificationFailure !== undefined) {
      throw new AggregateError(
        [qualificationFailure, cleanupFailure],
        "Runtime qualification and cleanup both failed.",
      );
    }
    throw cleanupFailure;
  });
}
