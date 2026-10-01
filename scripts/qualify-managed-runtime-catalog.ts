#!/usr/bin/env node

// @effect-diagnostics nodeBuiltinImport:off -- Native CI qualification intentionally exercises provider downloads in an isolated temporary runtime root.
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
  type ManagedProviderRuntime,
  type ManagedRuntimeArtifact,
  type ManagedRuntimeProvider,
} from "@scientfactory/provider-runtime";
import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";

import {
  validateManagedRuntimeCatalog,
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
 * Oh My Pi is published only after the installed binary completes the app's
 * managed-activation check: the RPC v2 handshake, its version, and
 * `get_state`. The check lives with the server code that clients run, so it
 * needs the server workspace dependencies installed.
 */
async function verifyOmpRpc(binary: string, version: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = NodeChildProcess.spawn(
      process.execPath,
      ["apps/server/scripts/qualify-omp-rpc.ts", "--binary", binary, "--version", version],
      { cwd: process.cwd(), env: process.env, stdio: "inherit", windowsHide: true },
    );
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(
            `Oh My Pi RPC qualification failed${signal ? ` with signal ${signal}` : ` with exit code ${String(code)}`}.`,
          ),
        );
    });
  });
}

const providerFactories: Readonly<
  Record<
    ManagedRuntimeProvider,
    {
      readonly policy: (
        target: ReturnType<typeof detectManagedRuntimeTarget>,
      ) => ManagedRuntimeArtifact | undefined;
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
};

const target = await Effect.runPromise(
  Effect.gen(function* () {
    return detectManagedRuntimeTarget({
      platform: yield* HostProcessPlatform,
      arch: yield* HostProcessArchitecture,
    });
  }),
);
const targetKey = managedRuntimeTargetKey(target);
const factory = providerFactories[provider];
const policy = factory.policy(target);
if (!policy) throw new Error(`${provider} does not support native CI target ${targetKey}.`);

const catalog = validateManagedRuntimeCatalog(
  JSON.parse(await NodeFSP.readFile(catalogPath, "utf8")),
);
const release = validateManagedRuntimeCandidate(catalog, provider);
const artifactData = release.artifacts[targetKey];
if (!artifactData) {
  throw new Error(`${provider} catalog does not contain approved native target ${targetKey}.`);
}
const artifact = hydrateManagedRuntimeArtifact(policy, {
  provider,
  version: release.version,
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
  await runtime.install({ artifact, signal: AbortSignal.timeout(15 * 60_000) });
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
  if (provider === "omp") await verifyOmpRpc(status.launchPath, artifact.version);
  if (process.argv.includes("--repair")) {
    await runtime.install({ artifact, signal: AbortSignal.timeout(15 * 60_000) });
    const repaired = await runtime.status(artifact);
    if (!repaired.installed || !repaired.selected || repaired.activeVersion !== artifact.version) {
      throw new Error(`${provider} ${targetKey} did not repair the qualified release.`);
    }
    if (provider === "omp") await verifyOmpRpc(repaired.launchPath, artifact.version);
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
