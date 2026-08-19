// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../config.ts";
import type { PersistedOverleafConnection } from "./model.ts";
import { layer as stateStoreLayer, OverleafStateStore } from "./OverleafStateStore.ts";

const temporaryDirectory = Effect.acquireRelease(
  Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "overleaf-state-"))),
  (root) => Effect.promise(() => NodeFSP.rm(root, { recursive: true, force: true })),
);

function storeLayer(baseDir: string) {
  const config = ServerConfig.layerTest(process.cwd(), baseDir);
  const secrets = ServerSecretStore.layer.pipe(
    Layer.provide(config),
    Layer.provideMerge(NodeServices.layer),
  );
  return stateStoreLayer.pipe(
    Layer.provide(config),
    Layer.provide(secrets),
    Layer.provideMerge(NodeServices.layer),
  );
}

function connectionFixture(baseDir: string): PersistedOverleafConnection {
  return {
    connectionId: NodeCrypto.randomUUID(),
    accountId: NodeCrypto.randomUUID(),
    label: "Paper",
    workspaceRoot: baseDir,
    relativeFolder: "paper",
    projectUrl: "https://www.overleaf.com/project/0123456789abcdef01234567",
    gitUrl: "https://git.overleaf.com/0123456789abcdef01234567",
    host: "git.overleaf.com",
    branch: "master",
    commitPolicy: { kind: "neutral" },
    suppressRenameWarning: false,
    state: "ready",
    remoteBaselineCommit: "0123456789abcdef0123456789abcdef01234567",
    lastConvergedCommit: "0123456789abcdef0123456789abcdef01234567",
    localAhead: false,
    localOnlyCompanions: [],
    lastSyncedAtEpochMs: null,
    workspaceBaselineManifest: { files: [], totalBytes: 0 },
    pendingRemoteCommit: null,
    activeOperationId: null,
  };
}

describe("OverleafStateStore", () => {
  it.effect("serializes atomic operation updates without losing a generation", () =>
    Effect.gen(function* () {
      const baseDir = yield* temporaryDirectory;
      const result = yield* Effect.gen(function* () {
        const state = yield* OverleafStateStore;
        const created = yield* state.createOperation("connect", null, {});
        const append = (suffix: string) =>
          state.updateOperation(created.snapshot.operationId, (current) => ({
            ...current,
            snapshot: {
              ...current.snapshot,
              generation: current.snapshot.generation + 1,
              message: `${current.snapshot.message}${suffix}`,
            },
          }));
        yield* Effect.all([append("A"), append("B")], { concurrency: "unbounded" });
        return yield* state.getOperation(created.snapshot.operationId);
      }).pipe(Effect.provide(storeLayer(baseDir)));
      expect(result.snapshot.generation).toBe(3);
      expect(result.snapshot.message).toMatch(/Preparing Overleaf operation…(?:AB|BA)$/u);
    }).pipe(Effect.scoped),
  );

  it.effect("quarantines a corrupt registry instead of preventing server startup", () =>
    Effect.gen(function* () {
      const baseDir = yield* temporaryDirectory;
      const root = yield* Effect.gen(function* () {
        return (yield* OverleafStateStore).root;
      }).pipe(Effect.provide(storeLayer(baseDir)));
      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(NodePath.join(root, "connections", NodeCrypto.randomUUID()), {
          recursive: true,
        });
        await NodeFSP.writeFile(NodePath.join(root, "registry.json"), "not json", "utf8");
      });
      const overview = yield* Effect.gen(function* () {
        return yield* (yield* OverleafStateStore).overview(baseDir);
      }).pipe(Effect.provide(storeLayer(baseDir)));
      expect(overview.connections).toEqual([]);
      expect(overview.operations).toEqual([]);
      const quarantined = yield* Effect.promise(() =>
        NodeFSP.readdir(NodePath.join(root, "quarantine")),
      );
      expect(quarantined.some((name) => name.startsWith("registry-"))).toBe(true);
      expect(quarantined.some((name) => name.startsWith("unindexed-connections-"))).toBe(true);
    }).pipe(Effect.scoped),
  );

  it.effect("quarantines mismatched connection record revisions", () =>
    Effect.gen(function* () {
      const baseDir = yield* temporaryDirectory;
      const fixture = connectionFixture(baseDir);
      const root = yield* Effect.gen(function* () {
        const state = yield* OverleafStateStore;
        yield* state.createConnection(fixture);
        return state.root;
      }).pipe(Effect.provide(storeLayer(baseDir)));
      const baselinePath = NodePath.join(
        root,
        "connections",
        fixture.connectionId,
        "baseline.json",
      );
      yield* Effect.promise(async () => {
        const baseline = await NodeFSP.readFile(baselinePath, "utf8");
        const mismatched = baseline.replace(
          /"recordRevision"\s*:\s*"[^"]+"/u,
          `"recordRevision":"${NodeCrypto.randomUUID()}"`,
        );
        if (mismatched === baseline) throw new Error("Fixture record revision was not present.");
        await NodeFSP.writeFile(baselinePath, mismatched, "utf8");
      });
      const overview = yield* Effect.gen(function* () {
        return yield* (yield* OverleafStateStore).overview(baseDir);
      }).pipe(Effect.provide(storeLayer(baseDir)));
      expect(overview.connections).toEqual([]);
      const quarantined = yield* Effect.promise(() =>
        NodeFSP.readdir(NodePath.join(root, "quarantine")),
      );
      expect(
        quarantined.some((name) => name.startsWith(`connection-${fixture.connectionId}-`)),
      ).toBe(true);
    }).pipe(Effect.scoped),
  );
});
