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
const catalogPath = NodePath.resolve(
  argument("--catalog") ??
    "apps/server/src/scient/providerLifecycle/bundled-managed-runtime-catalog.json",
);
if (!provider) throw new Error("--provider is required.");
if (runPiLiveTests && provider !== "pi") {
  throw new Error("--pi-live-tests is valid only for Pi qualification.");
}

async function verifyPiIntegration(
  binary: string,
  version: string,
  platform: NodeJS.Platform,
): Promise<void> {
  const tests = [
    "apps/server/src/provider/pi/PiCustomModels.live.test.ts",
    "apps/server/src/provider/pi/PiNativeProvider.live.test.ts",
    "apps/server/src/provider/pi/PiReasoning.live.test.ts",
    "apps/server/src/provider/pi/PiRuntime.live.test.ts",
    "apps/server/src/provider/pi/PiXai.live.test.ts",
  ];
  await new Promise<void>((resolve, reject) => {
    const child = NodeChildProcess.spawn("vp", ["test", "run", "--no-file-parallelism", ...tests], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        SCIENT_PI_TEST_BINARY: binary,
        SCIENT_PI_TEST_VERSION: version,
      },
      // Windows cannot execute a package-manager .cmd shim directly through spawn.
      // The shell is needed only to resolve the fixed `vp` command; all arguments are static.
      shell: platform === "win32",
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(
            `Pi integration qualification failed${signal ? ` with signal ${signal}` : ` with exit code ${String(code)}`}.`,
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
  if (process.argv.includes("--repair")) {
    await runtime.install({ artifact, signal: AbortSignal.timeout(15 * 60_000) });
    const repaired = await runtime.status(artifact);
    if (!repaired.installed || !repaired.selected || repaired.activeVersion !== artifact.version) {
      throw new Error(`${provider} ${targetKey} did not repair the qualified release.`);
    }
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
