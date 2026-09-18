// @effect-diagnostics nodeBuiltinImport:off -- Persistence restart proof uses a real temporary database.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  makeSqlitePersistenceLive,
  SqlitePersistenceMemory,
} from "../../persistence/Layers/Sqlite.ts";
import {
  type ObservedWorkspaceEvidence,
  WorkspaceAuthorityGeneration,
} from "./WorkspaceBinding.ts";
import { WorkspaceBindingStore, layer } from "./WorkspaceBindingStore.ts";

const ENVIRONMENT_ONE = EnvironmentId.make("environment-one");
const ENVIRONMENT_TWO = EnvironmentId.make("environment-two");
const PROJECT_ONE = ProjectId.make("project-one");
const PROJECT_TWO = ProjectId.make("project-two");
const SCIENT_PROJECT_ID = "79efda70-b258-48c1-8e55-3755a08ffb1f";

const observed = (
  canonicalRoot: string,
  input: Partial<ObservedWorkspaceEvidence> = {},
): ObservedWorkspaceEvidence => ({
  canonicalRoot,
  rootFileSystemIdentity: { device: "1", inode: canonicalRoot },
  scientProjectId: SCIENT_PROJECT_ID,
  scientProjectIdentityState: "initialized",
  repositoryIdentity: {
    canonicalKey: "github.com/scientfactory/example",
    source: "git-remote",
    remoteName: "origin",
  },
  worktreeIdentity: {
    kind: "git",
    rootPath: canonicalRoot,
    metadataPath: "/repositories/example/.git",
  },
  trustState: "verified",
  observedAt: "2026-08-29T10:00:00.000Z",
  ...input,
});

const storeLayer = layer.pipe(
  Layer.provide(SqlitePersistenceMemory),
  Layer.provide(NodeServices.layer),
);

describe("WorkspaceBindingStore", () => {
  it.effect("reassociation requires the exact prior binding and the same physical root", () =>
    Effect.gen(function* () {
      const store = yield* WorkspaceBindingStore;
      const evidence = observed("/readded");
      const first = yield* store.verifyObserved({
        environmentId: ENVIRONMENT_ONE,
        hostProjectId: PROJECT_ONE,
        evidence,
      });
      for (const next of [
        evidence,
        { ...evidence, rootFileSystemIdentity: null },
        { ...evidence, rootFileSystemIdentity: { device: "1", inode: "replacement" } },
        { ...evidence, trustState: "ambiguous" as const },
      ]) {
        const input = {
          environmentId: ENVIRONMENT_ONE,
          hostProjectId: PROJECT_TWO,
          evidence: next,
        };
        expect((yield* store.verifyObserved(input).pipe(Effect.flip)).kind).toBe("root-conflict");
        if (next !== evidence)
          expect(
            (yield* store
              .verifyObserved({ ...input, reassociateBindingId: first.binding.bindingId })
              .pipe(Effect.flip)).kind,
          ).toBe("root-conflict");
        expect(yield* store.getById(first.binding.bindingId)).toEqual(first.binding);
      }
      const readded = yield* store.verifyObserved({
        environmentId: ENVIRONMENT_ONE,
        hostProjectId: PROJECT_TWO,
        evidence,
        reassociateBindingId: first.binding.bindingId,
      });
      expect(readded.binding.bindingId).toBe(first.binding.bindingId);
      expect(readded.binding.authorityGeneration).toBe(2);
    }).pipe(Effect.provide(storeLayer)),
  );

  it.effect("replacement confirmation cannot transfer a binding to another host project", () =>
    Effect.gen(function* () {
      const store = yield* WorkspaceBindingStore;
      const first = yield* store.verifyObserved({
        environmentId: ENVIRONMENT_ONE,
        hostProjectId: PROJECT_ONE,
        evidence: observed("/original"),
      });
      const denied = yield* store
        .confirmReplacement({
          currentBindingId: first.binding.bindingId,
          environmentId: ENVIRONMENT_ONE,
          hostProjectId: PROJECT_TWO,
          evidence: observed("/relocated"),
        })
        .pipe(Effect.flip);
      expect(denied.kind).toBe("replacement-conflict");
      expect(yield* store.getById(first.binding.bindingId)).toEqual(first.binding);
    }).pipe(Effect.provide(storeLayer)),
  );
  it.effect("keeps one history identity through folder initialization and Git setup", () =>
    Effect.gen(function* () {
      const store = yield* WorkspaceBindingStore;
      const root = "/plain-folder";
      const first = yield* store.verifyObserved({
        environmentId: ENVIRONMENT_ONE,
        hostProjectId: PROJECT_ONE,
        evidence: observed(root, {
          scientProjectId: null,
          scientProjectIdentityState: "ordinary",
          repositoryIdentity: null,
          worktreeIdentity: null,
        }),
      });
      const initialized = yield* store.verifyObserved({
        environmentId: ENVIRONMENT_ONE,
        hostProjectId: PROJECT_ONE,
        evidence: observed(root),
      });
      expect(initialized.binding.bindingId).toBe(first.binding.bindingId);
      expect(initialized.binding.authorityGeneration).toBe(2);
      expect(initialized.binding.createdAt).toBe(first.binding.createdAt);
      const unavailable = yield* store
        .verifyObserved({
          environmentId: ENVIRONMENT_ONE,
          hostProjectId: PROJECT_ONE,
          evidence: observed(root, { rootFileSystemIdentity: null }),
        })
        .pipe(Effect.flip);
      expect(unavailable.kind).toBe("root-conflict");
      expect(yield* store.getById(first.binding.bindingId)).toEqual(initialized.binding);
    }).pipe(Effect.provide(storeLayer)),
  );

  it.effect("reuses a stable exact binding and only refreshes its verification time", () =>
    Effect.gen(function* () {
      const store = yield* WorkspaceBindingStore;
      const first = yield* store.verifyObserved({
        environmentId: ENVIRONMENT_ONE,
        hostProjectId: PROJECT_ONE,
        evidence: observed("/worktrees/one"),
      });
      const second = yield* store.verifyObserved({
        environmentId: ENVIRONMENT_ONE,
        hostProjectId: PROJECT_ONE,
        evidence: observed("/worktrees/one", {
          observedAt: "2026-08-29T10:01:00.000Z",
        }),
      });

      expect(second.binding.bindingId).toBe(first.binding.bindingId);
      expect(second.binding.authorityGeneration).toBe(1);
      expect(second.binding.lastVerifiedAt).toBe("2026-08-29T10:01:00.000Z");
      expect(second.relation).toBe("only-binding");
      expect(
        yield* store.listByScientProjectId({
          environmentId: ENVIRONMENT_ONE,
          scientProjectId: SCIENT_PROJECT_ID,
          includeSuperseded: true,
        }),
      ).toHaveLength(1);
    }).pipe(Effect.provide(storeLayer)),
  );

  it.effect("refreshes a remote alias without replacing the workspace authority", () =>
    Effect.gen(function* () {
      const store = yield* WorkspaceBindingStore;
      const evidence = observed("/worktrees/remote-alias");
      const first = yield* store.verifyObserved({
        environmentId: ENVIRONMENT_ONE,
        hostProjectId: PROJECT_ONE,
        evidence,
      });
      const childInput = {
        environmentId: ENVIRONMENT_ONE,
        hostProjectId: PROJECT_ONE,
        evidence: observed("/worktrees/remote-alias-child"),
        lineageBindingId: first.binding.bindingId,
      };
      const child = yield* store.verifyObserved(childInput);
      const repositoryIdentity = {
        canonicalKey: "github.com/scientfactory/example",
        source: "git-remote" as const,
        remoteName: "upstream",
      };
      const second = yield* store.verifyObserved({
        environmentId: ENVIRONMENT_ONE,
        hostProjectId: PROJECT_ONE,
        evidence: { ...evidence, repositoryIdentity, observedAt: "2026-08-29T10:01:00.000Z" },
      });

      expect(second.binding.bindingId).toBe(first.binding.bindingId);
      expect(second.binding.authorityGeneration).toBe(first.binding.authorityGeneration);
      expect(second.binding.repositoryIdentity).toEqual(repositoryIdentity);
      expect((yield* store.getById(first.binding.bindingId))?.repositoryIdentity).toEqual(
        repositoryIdentity,
      );
      expect(yield* store.assertCurrent(first.binding)).toEqual(second.binding);
      const stillRelated = yield* store.verifyObserved(childInput);
      expect(stillRelated.binding.bindingId).toBe(child.binding.bindingId);
      expect(stillRelated.binding.lineageBindingId).toBe(second.binding.bindingId);
      expect(stillRelated.relation).toBe("trusted-lineage");
      expect(
        yield* store.listByScientProjectId({
          environmentId: ENVIRONMENT_ONE,
          scientProjectId: SCIENT_PROJECT_ID,
          includeSuperseded: true,
        }),
      ).toHaveLength(2);

      const changedRepository = yield* store.verifyObserved({
        environmentId: ENVIRONMENT_ONE,
        hostProjectId: PROJECT_ONE,
        evidence: {
          ...evidence,
          repositoryIdentity: {
            ...repositoryIdentity,
            canonicalKey: "github.com/scientfactory/other",
          },
        },
      });
      expect(changedRepository.binding.bindingId).toBe(first.binding.bindingId);
      expect(changedRepository.binding.authorityGeneration).toBe(2);
    }).pipe(Effect.provide(storeLayer)),
  );

  it.effect("converges concurrent observations of the same exact authority", () =>
    Effect.gen(function* () {
      const store = yield* WorkspaceBindingStore;
      const bindings = yield* Effect.all(
        Array.from({ length: 8 }, (_, index) =>
          store.verifyObserved({
            environmentId: ENVIRONMENT_ONE,
            hostProjectId: PROJECT_ONE,
            evidence: observed("/worktrees/concurrent", {
              observedAt: `2026-08-29T10:00:0${index}.000Z`,
            }),
          }),
        ),
        { concurrency: "unbounded" },
      );

      expect(new Set(bindings.map((binding) => binding.binding.bindingId)).size).toBe(1);
      expect(
        yield* store.listByScientProjectId({
          environmentId: ENVIRONMENT_ONE,
          scientProjectId: SCIENT_PROJECT_ID,
          includeSuperseded: true,
        }),
      ).toHaveLength(1);
    }).pipe(Effect.provide(storeLayer)),
  );

  it.effect("rehydrates the exact binding and generation across a database-layer restart", () => {
    const temporaryDirectory = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "scient-workspace-binding-restart-"),
    );
    const databasePath = NodePath.join(temporaryDirectory, "state.sqlite");
    const restartLayer = layer.pipe(
      Layer.provide(makeSqlitePersistenceLive(databasePath)),
      Layer.provide(NodeServices.layer),
    );

    return Effect.gen(function* () {
      const first = yield* Effect.gen(function* () {
        const store = yield* WorkspaceBindingStore;
        return yield* store.verifyObserved({
          environmentId: ENVIRONMENT_ONE,
          hostProjectId: PROJECT_ONE,
          evidence: observed("/worktrees/persisted"),
        });
      }).pipe(Effect.provide(restartLayer));

      const second = yield* Effect.gen(function* () {
        const store = yield* WorkspaceBindingStore;
        return yield* store.verifyObserved({
          environmentId: ENVIRONMENT_ONE,
          hostProjectId: PROJECT_ONE,
          evidence: observed("/worktrees/persisted", {
            observedAt: "2026-08-29T10:05:00.000Z",
          }),
        });
      }).pipe(Effect.provide(restartLayer));

      expect(second.binding.bindingId).toBe(first.binding.bindingId);
      expect(second.binding.authorityGeneration).toBe(first.binding.authorityGeneration);
      expect(second.binding.lastVerifiedAt).toBe("2026-08-29T10:05:00.000Z");
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => NodeFS.rmSync(temporaryDirectory, { recursive: true, force: true })),
      ),
    );
  });

  it.effect("retains history identity when metadata changes and fences the stale generation", () =>
    Effect.gen(function* () {
      const store = yield* WorkspaceBindingStore;
      const first = yield* store.verifyObserved({
        environmentId: ENVIRONMENT_ONE,
        hostProjectId: PROJECT_ONE,
        evidence: observed("/worktrees/one"),
      });
      const second = yield* store.verifyObserved({
        environmentId: ENVIRONMENT_ONE,
        hostProjectId: PROJECT_ONE,
        evidence: observed("/worktrees/one", {
          worktreeIdentity: {
            kind: "git",
            rootPath: "/worktrees/one",
            metadataPath: "/repositories/replaced/.git",
          },
          observedAt: "2026-08-29T10:02:00.000Z",
        }),
      });

      expect(second.binding.bindingId).toBe(first.binding.bindingId);
      expect(second.binding.authorityGeneration).toBe(2);
      expect((yield* store.getById(first.binding.bindingId))?.supersededBy).toBeNull();
      const stale = yield* store
        .assertCurrent({
          bindingId: first.binding.bindingId,
          authorityGeneration: first.binding.authorityGeneration,
        })
        .pipe(Effect.flip);
      expect(stale.kind).toBe("binding-not-found");
      expect(
        yield* store.assertCurrent({
          bindingId: second.binding.bindingId,
          authorityGeneration: second.binding.authorityGeneration,
        }),
      ).toEqual(second.binding);
    }).pipe(Effect.provide(storeLayer)),
  );

  it.effect("supersedes a same-path root when its filesystem identity changes", () =>
    Effect.gen(function* () {
      const store = yield* WorkspaceBindingStore;
      const first = yield* store.verifyObserved({
        environmentId: ENVIRONMENT_ONE,
        hostProjectId: PROJECT_ONE,
        evidence: observed("/worktrees/replaced-in-place", {
          rootFileSystemIdentity: { device: "7", inode: "101" },
        }),
      });
      const second = yield* store.verifyObserved({
        environmentId: ENVIRONMENT_ONE,
        hostProjectId: PROJECT_ONE,
        evidence: observed("/worktrees/replaced-in-place", {
          rootFileSystemIdentity: { device: "7", inode: "202" },
          observedAt: "2026-08-29T10:03:00.000Z",
        }),
      });

      expect(second.binding.bindingId).not.toBe(first.binding.bindingId);
      expect(second.binding.authorityGeneration).toBe(2);
      expect((yield* store.getById(first.binding.bindingId))?.supersededBy).toBe(
        second.binding.bindingId,
      );
    }).pipe(Effect.provide(storeLayer)),
  );

  it.effect("rejects two active host projects claiming one exact root", () =>
    Effect.gen(function* () {
      const store = yield* WorkspaceBindingStore;
      const first = yield* store.verifyObserved({
        environmentId: ENVIRONMENT_ONE,
        hostProjectId: PROJECT_ONE,
        evidence: observed("/shared/root"),
      });
      const conflict = yield* store
        .verifyObserved({
          environmentId: ENVIRONMENT_ONE,
          hostProjectId: PROJECT_TWO,
          evidence: observed("/shared/root"),
        })
        .pipe(Effect.flip);

      expect(conflict.kind).toBe("root-conflict");
      expect(
        yield* store.assertCurrent({
          bindingId: first.binding.bindingId,
          authorityGeneration: first.binding.authorityGeneration,
        }),
      ).toEqual(first.binding);
    }).pipe(Effect.provide(storeLayer)),
  );

  it.effect("keeps copied logical project IDs separate without trusted lineage", () =>
    Effect.gen(function* () {
      const store = yield* WorkspaceBindingStore;
      const first = yield* store.verifyObserved({
        environmentId: ENVIRONMENT_ONE,
        hostProjectId: PROJECT_ONE,
        evidence: observed("/clones/one"),
      });
      const second = yield* store.verifyObserved({
        environmentId: ENVIRONMENT_ONE,
        hostProjectId: PROJECT_TWO,
        evidence: observed("/clones/two", {
          worktreeIdentity: {
            kind: "git",
            rootPath: "/clones/two",
            metadataPath: "/clones/two/.git",
          },
        }),
      });
      const refreshedFirst = yield* store.verifyObserved({
        environmentId: ENVIRONMENT_ONE,
        hostProjectId: PROJECT_ONE,
        evidence: observed("/clones/one"),
      });

      expect(first.binding.bindingId).not.toBe(second.binding.bindingId);
      expect(second.relation).toBe("unverified-shared-project-id");
      expect(refreshedFirst.relation).toBe("unverified-shared-project-id");
      expect(refreshedFirst.relatedBindingCount).toBe(1);
    }).pipe(Effect.provide(storeLayer)),
  );

  it.effect("records a host-verified child worktree as trusted lineage", () =>
    Effect.gen(function* () {
      const store = yield* WorkspaceBindingStore;
      const parent = yield* store.verifyObserved({
        environmentId: ENVIRONMENT_ONE,
        hostProjectId: PROJECT_ONE,
        evidence: observed("/repository/main"),
      });
      const child = yield* store.verifyObserved({
        environmentId: ENVIRONMENT_ONE,
        hostProjectId: PROJECT_ONE,
        evidence: observed("/repository/worktrees/child", {
          worktreeIdentity: {
            kind: "git",
            rootPath: "/repository/worktrees/child",
            metadataPath: "/repositories/example/.git",
          },
        }),
        lineageBindingId: parent.binding.bindingId,
      });

      expect(child.binding.lineageBindingId).toBe(parent.binding.bindingId);
      expect(child.relation).toBe("trusted-lineage");
      expect(child.relatedBindingCount).toBe(1);
    }).pipe(Effect.provide(storeLayer)),
  );

  it.effect("rejects claimed lineage without shared VCS worktree evidence", () =>
    Effect.gen(function* () {
      const store = yield* WorkspaceBindingStore;
      const parent = yield* store.verifyObserved({
        environmentId: ENVIRONMENT_ONE,
        hostProjectId: PROJECT_ONE,
        evidence: observed("/repository/main"),
      });
      const error = yield* store
        .verifyObserved({
          environmentId: ENVIRONMENT_ONE,
          hostProjectId: PROJECT_TWO,
          evidence: observed("/independent/copy", {
            worktreeIdentity: {
              kind: "git",
              rootPath: "/independent/copy",
              metadataPath: "/independent/copy/.git",
            },
          }),
          lineageBindingId: parent.binding.bindingId,
        })
        .pipe(Effect.flip);

      expect(error.kind).toBe("lineage-conflict");
      expect(
        yield* store.assertCurrent({
          bindingId: parent.binding.bindingId,
          authorityGeneration: parent.binding.authorityGeneration,
        }),
      ).toEqual(parent.binding);
      expect(
        yield* store.listByScientProjectId({
          environmentId: ENVIRONMENT_ONE,
          scientProjectId: SCIENT_PROJECT_ID,
          includeSuperseded: true,
        }),
      ).toHaveLength(1);
    }).pipe(Effect.provide(storeLayer)),
  );

  it.effect("never relates bindings across environments", () =>
    Effect.gen(function* () {
      const store = yield* WorkspaceBindingStore;
      const local = yield* store.verifyObserved({
        environmentId: ENVIRONMENT_ONE,
        hostProjectId: PROJECT_ONE,
        evidence: observed("/same/path"),
      });
      const remote = yield* store.verifyObserved({
        environmentId: ENVIRONMENT_TWO,
        hostProjectId: PROJECT_ONE,
        evidence: observed("/same/path"),
      });

      expect(local.binding.bindingId).not.toBe(remote.binding.bindingId);
      expect(local.relation).toBe("only-binding");
      expect(remote.relation).toBe("only-binding");
    }).pipe(Effect.provide(storeLayer)),
  );

  it.effect("supports exact authority for an ordinary uninitialized folder", () =>
    Effect.gen(function* () {
      const store = yield* WorkspaceBindingStore;
      const binding = yield* store.verifyObserved({
        environmentId: ENVIRONMENT_ONE,
        hostProjectId: PROJECT_ONE,
        evidence: observed("/ordinary/folder", {
          scientProjectId: null,
          scientProjectIdentityState: "ordinary",
          repositoryIdentity: null,
          worktreeIdentity: null,
        }),
      });

      expect(binding.binding.scientProjectId).toBeNull();
      expect(binding.binding.trustState).toBe("verified");
      expect(binding.relation).toBe("only-binding");
    }).pipe(Effect.provide(storeLayer)),
  );

  it.effect("revocation advances authority and cannot be undone by observation", () =>
    Effect.gen(function* () {
      const store = yield* WorkspaceBindingStore;
      const current = yield* store.verifyObserved({
        environmentId: ENVIRONMENT_ONE,
        hostProjectId: PROJECT_ONE,
        evidence: observed("/worktrees/revoked"),
      });
      const revoked = yield* store.revoke(current.binding.bindingId);
      expect(revoked.trustState).toBe("revoked");
      expect(revoked.authorityGeneration).toBe(2);

      const error = yield* store
        .verifyObserved({
          environmentId: ENVIRONMENT_ONE,
          hostProjectId: PROJECT_ONE,
          evidence: observed("/worktrees/revoked"),
        })
        .pipe(Effect.flip);
      expect(error.kind).toBe("binding-revoked");
      const stale = yield* store
        .assertCurrent({
          bindingId: current.binding.bindingId,
          authorityGeneration: WorkspaceAuthorityGeneration.make(1),
        })
        .pipe(Effect.flip);
      expect(stale.kind).toBe("binding-revoked");
    }).pipe(Effect.provide(storeLayer)),
  );

  it.effect("confirms relocation transactionally and preserves the prior record", () =>
    Effect.gen(function* () {
      const store = yield* WorkspaceBindingStore;
      const current = yield* store.verifyObserved({
        environmentId: ENVIRONMENT_ONE,
        hostProjectId: PROJECT_ONE,
        evidence: observed("/repository/before"),
      });
      const replacement = yield* store.confirmReplacement({
        currentBindingId: current.binding.bindingId,
        environmentId: ENVIRONMENT_ONE,
        hostProjectId: PROJECT_ONE,
        evidence: observed("/repository/after", {
          worktreeIdentity: {
            kind: "git",
            rootPath: "/repository/after",
            metadataPath: "/repositories/example/.git",
          },
        }),
      });

      expect(replacement.binding.authorityGeneration).toBe(2);
      expect(replacement.binding.lineageBindingId).toBe(current.binding.bindingId);
      expect((yield* store.getById(current.binding.bindingId))?.supersededBy).toBe(
        replacement.binding.bindingId,
      );
    }).pipe(Effect.provide(storeLayer)),
  );

  it.effect("rolls back a rejected relocation without changing current authority", () =>
    Effect.gen(function* () {
      const store = yield* WorkspaceBindingStore;
      const current = yield* store.verifyObserved({
        environmentId: ENVIRONMENT_ONE,
        hostProjectId: PROJECT_ONE,
        evidence: observed("/repository/before"),
      });
      yield* store.verifyObserved({
        environmentId: ENVIRONMENT_ONE,
        hostProjectId: PROJECT_TWO,
        evidence: observed("/repository/occupied", { scientProjectId: "another-project" }),
      });

      const conflict = yield* store
        .confirmReplacement({
          currentBindingId: current.binding.bindingId,
          environmentId: ENVIRONMENT_ONE,
          hostProjectId: PROJECT_ONE,
          evidence: observed("/repository/occupied"),
        })
        .pipe(Effect.flip);
      expect(conflict.kind).toBe("replacement-conflict");
      expect(
        yield* store.assertCurrent({
          bindingId: current.binding.bindingId,
          authorityGeneration: current.binding.authorityGeneration,
        }),
      ).toEqual(current.binding);
    }).pipe(Effect.provide(storeLayer)),
  );

  it.effect("rejects an explicitly confirmed relocation whose destination is ambiguous", () =>
    Effect.gen(function* () {
      const store = yield* WorkspaceBindingStore;
      const current = yield* store.verifyObserved({
        environmentId: ENVIRONMENT_ONE,
        hostProjectId: PROJECT_ONE,
        evidence: observed("/repository/before"),
      });

      const conflict = yield* store
        .confirmReplacement({
          currentBindingId: current.binding.bindingId,
          environmentId: ENVIRONMENT_ONE,
          hostProjectId: PROJECT_ONE,
          evidence: observed("/repository/ambiguous", {
            scientProjectIdentityState: "recoverable",
            trustState: "ambiguous",
          }),
        })
        .pipe(Effect.flip);

      expect(conflict.kind).toBe("replacement-conflict");
      expect(
        yield* store.assertCurrent({
          bindingId: current.binding.bindingId,
          authorityGeneration: current.binding.authorityGeneration,
        }),
      ).toEqual(current.binding);
    }).pipe(Effect.provide(storeLayer)),
  );

  it.effect("persists ambiguous bindings but refuses to issue current authority", () =>
    Effect.gen(function* () {
      const store = yield* WorkspaceBindingStore;
      const ambiguous = yield* store.verifyObserved({
        environmentId: ENVIRONMENT_ONE,
        hostProjectId: PROJECT_ONE,
        evidence: observed("/repository/recoverable", {
          scientProjectId: null,
          scientProjectIdentityState: "recoverable",
          trustState: "ambiguous",
        }),
      });

      expect(ambiguous.binding.trustState).toBe("ambiguous");
      const error = yield* store
        .assertCurrent({
          bindingId: ambiguous.binding.bindingId,
          authorityGeneration: ambiguous.binding.authorityGeneration,
        })
        .pipe(Effect.flip);
      expect(error.kind).toBe("binding-not-found");
    }).pipe(Effect.provide(storeLayer)),
  );
});
