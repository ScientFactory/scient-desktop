#!/usr/bin/env node

// @effect-diagnostics nodeBuiltinImport:off -- Native CI qualification intentionally exercises provider downloads in an isolated temporary runtime root.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  ManagedAntigravityRuntime,
  ManagedClaudeRuntime,
  ManagedCodexRuntime,
  ManagedCursorRuntime,
  ManagedDroidRuntime,
  ManagedGrokRuntime,
  detectManagedRuntimeTarget,
  hydrateManagedRuntimeArtifact,
  managedRuntimeTargetKey,
  resolveReviewedAntigravityArtifact,
  resolveReviewedClaudeArtifact,
  resolveReviewedCodexArtifact,
  resolveReviewedCursorArtifact,
  resolveReviewedDroidArtifact,
  resolveReviewedGrokArtifact,
  type ManagedProviderRuntime,
  type ManagedRuntimeArtifact,
  type ManagedRuntimeProvider,
} from "@scientfactory/provider-runtime";
import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";

import type { ManagedRuntimeCatalogData } from "./lib/managed-runtime-catalog.ts";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const provider = argument("--provider") as ManagedRuntimeProvider | undefined;
const catalogPath = NodePath.resolve(
  argument("--catalog") ?? "apps/server/src/scient/providerLifecycle/managed-runtime-catalog.json",
);
if (!provider) throw new Error("--provider is required.");

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

const catalog = JSON.parse(
  await NodeFSP.readFile(catalogPath, "utf8"),
) as ManagedRuntimeCatalogData;
const release = catalog.providers[provider];
const artifactData = release?.artifacts[targetKey];
if (!release || release.contractRevision !== 1 || release.channel !== "stable" || !artifactData) {
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
    "contract-1",
    release.version,
    targetKey,
    artifactData.checksum.algorithm,
    artifactData.checksum.digest,
  ].join(":"),
});
if (!artifact) throw new Error(`${provider} ${targetKey} violates app-owned runtime policy.`);

const root = await NodeFSP.mkdtemp(
  NodePath.join(NodeOS.tmpdir(), `scient-${provider}-qualification-`),
);
try {
  const runtime = factory.runtime(root);
  await runtime.install({ artifact, signal: AbortSignal.timeout(15 * 60_000) });
  const status = await runtime.status(artifact);
  if (!status.installed || !status.selected || status.activeVersion !== artifact.version) {
    throw new Error(`${provider} ${targetKey} did not activate the qualified release.`);
  }
  await runtime.remove();
  const removed = await runtime.status(artifact);
  if (removed.installed || removed.selected) {
    throw new Error(`${provider} ${targetKey} did not cleanly remove the qualification runtime.`);
  }
  process.stdout.write(
    `${provider} ${artifact.version} passed native ${targetKey} qualification.\n`,
  );
} finally {
  await NodeFSP.rm(root, { recursive: true, force: true });
}
