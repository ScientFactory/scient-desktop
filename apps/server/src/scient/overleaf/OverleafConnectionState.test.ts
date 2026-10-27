// @effect-diagnostics nodeBuiltinImport:off -- Builds a throwaway repository with real Git.
// Coordinator contract step 1: the evidence rules of sections 6 and 8 as the
// store enforces them (A12-A15 and A31 at the state level; A21's retention clock).
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as NodeServices from "@effect/platform-node/NodeServices";

import {
  decodeOverleafConnectionDocument,
  OverleafConnectionDocument,
  type OverleafPublicationAttempt,
  overleafRequiredPins,
  overleafRetainedCopyReleasable,
  overleafTransitionViolation,
} from "./OverleafConnectionState.ts";
import * as OverleafGitExecutor from "./OverleafGitExecutor.ts";
import * as OverleafRepository from "./OverleafRepository.ts";
import { overleafConnectionFixture } from "./OverleafConnectionState.testkit.ts";

const NOW = Date.parse("2026-10-13T12:00:00.000Z");
const oid = (digit: string) => digit.repeat(40);
const decodeDocument = Schema.decodeUnknownExit(OverleafConnectionDocument);
const isValid = (value: unknown) => Exit.isSuccess(decodeDocument(value));

/** A connection whose first sync established base generation 1. */
const synced: OverleafConnectionDocument = {
  ...overleafConnectionFixture(),
  base: { commit: oid("1"), tree: oid("2"), generation: 1 },
  completedSyncCount: 1,
};

const attempt = (
  attemptNumber: number,
  change: Partial<OverleafPublicationAttempt> = {},
): OverleafPublicationAttempt => ({
  attemptNumber,
  operationId: `operation-${attemptNumber}`,
  requestId: `request-${attemptNumber}`,
  planDigest: "a".repeat(64),
  authority: { bindingId: "binding-1", authorityGeneration: 1, scopeRevision: 1 },
  branch: "main",
  parentCommit: oid("1"),
  candidateCommit: oid("c"),
  candidateTree: oid("d"),
  baseGeneration: 1,
  outcome: "unknown",
  evidence: null,
  recordedAt: "2026-10-13T11:00:00.000Z",
  ...change,
});

const next = (
  previous: OverleafConnectionDocument,
  change: Partial<OverleafConnectionDocument>,
): OverleafConnectionDocument => ({ ...previous, revision: previous.revision + 1, ...change });

const violation = (
  previous: OverleafConnectionDocument,
  change: Partial<OverleafConnectionDocument>,
) => overleafTransitionViolation(previous, next(previous, change), NOW);

/** Attempt 1 recorded unknown on base generation 1. */
const pending = next(synced, { lastAttemptNumber: 1, attempts: [attempt(1)] });

describe("marker disk identities", () => {
  it("reads older records without identities and round-trips verified identities", () => {
    expect(decodeOverleafConnectionDocument(JSON.stringify(synced))?.markerFileIds).toBeUndefined();
    const markerFileIds = [{ path: "a.tex", fileId: "a".repeat(64) }];
    expect(
      decodeOverleafConnectionDocument(JSON.stringify({ ...synced, markerFileIds }))?.markerFileIds,
    ).toEqual(markerFileIds);
    expect(
      isValid({ ...synced, markerFileIds: [{ path: "../a.tex", fileId: "a".repeat(64) }] }),
    ).toBe(false);
    expect(isValid({ ...synced, markerFileIds: [{ path: "a.tex", fileId: "invalid" }] })).toBe(
      false,
    );
  });
});

describe("overleafTransitionViolation", () => {
  it("accepts the next revision and refuses skipped or repeated revisions", () => {
    expect(violation(synced, {})).toBeNull();
    expect(overleafTransitionViolation(synced, { ...synced }, NOW)).toBe("revision-not-next");
    expect(overleafTransitionViolation(synced, { ...synced, revision: 3 }, NOW)).toBe(
      "revision-not-next",
    );
  });

  it("never rewinds or silently rewrites the base, and refuses changing who the connection is", () => {
    const advanced = next(synced, { base: { commit: oid("3"), tree: oid("4"), generation: 2 } });
    expect(overleafTransitionViolation(synced, advanced, NOW)).toBeNull();
    expect(violation(advanced, { base: { commit: oid("5"), tree: oid("6"), generation: 1 } })).toBe(
      "base-generation-decreased",
    );
    expect(violation(synced, { base: { ...synced.base, tree: oid("6") } })).toBe(
      "base-changed-without-generation",
    );
    expect(violation(synced, { remote: { ...synced.remote, projectId: "b".repeat(24) } })).toBe(
      "identity-changed",
    );
    expect(violation(synced, { completedSyncCount: 0 })).toBe("sync-count-decreased");
  });

  it("records a new attempt unknown, under a fresh number, on the current base", () => {
    expect(overleafTransitionViolation(synced, pending, NOW)).toBeNull();
    expect(
      violation(synced, {
        lastAttemptNumber: 1,
        attempts: [attempt(1, { outcome: "accepted", evidence: "push-accepted" })],
      }),
    ).toBe("attempt-not-recorded-unknown");
    expect(
      violation(synced, { lastAttemptNumber: 1, attempts: [attempt(1, { baseGeneration: 0 })] }),
    ).toBe("attempt-base-generation-mismatch");
    // A pruned attempt's number is never handed out again.
    const resolved = next(pending, {
      attempts: [attempt(1, { outcome: "out-of-date", evidence: "push-out-of-date" })],
    });
    const pruned = next(resolved, { attempts: [] });
    expect(overleafTransitionViolation(resolved, pruned, NOW)).toBeNull();
    expect(violation(pruned, { attempts: [attempt(1)] })).toBe("attempt-number-reused");
  });

  it("keeps who sent what fixed and only lets the classification move forward", () => {
    expect(violation(pending, { attempts: [] })).toBe("unresolved-attempt-dropped");
    expect(violation(pending, { attempts: [attempt(1, { requestId: "request-9" })] })).toBe(
      "attempt-rewritten",
    );
    expect(
      violation(pending, {
        attempts: [
          attempt(1, {
            authority: { bindingId: "binding-2", authorityGeneration: 1, scopeRevision: 1 },
          }),
        ],
      }),
    ).toBe("attempt-rewritten");
    const rejected = next(pending, {
      attempts: [attempt(1, { outcome: "out-of-date", evidence: "push-out-of-date" })],
    });
    expect(overleafTransitionViolation(pending, rejected, NOW)).toBeNull();
    expect(violation(rejected, { attempts: [attempt(1)] })).toBe("attempt-outcome-not-allowed");
    expect(
      violation(rejected, {
        attempts: [attempt(1, { outcome: "accepted", evidence: "push-accepted" })],
      }),
    ).toBe("attempt-outcome-not-allowed");
  });

  it("refuses an outcome without the evidence that establishes it", () => {
    expect(isValid(pending)).toBe(true);
    expect(isValid({ ...pending, attempts: [attempt(1, { outcome: "accepted" })] })).toBe(false);
    expect(
      isValid({
        ...pending,
        attempts: [attempt(1, { outcome: "not-sent", evidence: "push-accepted" })],
      }),
    ).toBe(false);
    expect(isValid({ ...pending, attempts: [attempt(1, { evidence: "superseded" })] })).toBe(false);
    expect(isValid({ ...pending, updatedAt: "2026-02-30T12:00:00.000Z" })).toBe(false);
    expect(isValid({ ...pending, updatedAt: "2028-02-29T23:59:59.000Z" })).toBe(true);
    expect(isValid({ ...pending, updatedAt: "2026-10-13T24:00:00.000Z" })).toBe(false);
  });

  it("adopts exactly the accepted candidate as the next base", () => {
    const adopted = { commit: oid("c"), tree: oid("d"), generation: 2 };
    expect(
      violation(pending, {
        base: adopted,
        attempts: [attempt(1, { outcome: "accepted", evidence: "remote-history" })],
      }),
    ).toBeNull();
    expect(
      violation(pending, {
        base: { ...adopted, tree: oid("e") },
        attempts: [attempt(1, { outcome: "accepted", evidence: "remote-history" })],
      }),
    ).toBe("accepted-base-mismatch");
    // Rejection preserves the post-apply base.
    expect(
      violation(pending, {
        base: adopted,
        attempts: [attempt(1, { outcome: "out-of-date", evidence: "push-out-of-date" })],
      }),
    ).toBe("rejection-moved-base");
    expect(
      violation(pending, {
        attempts: [attempt(1, { outcome: "not-sent", evidence: "send-refused" })],
      }),
    ).toBeNull();
  });

  it("supersedes an unknown attempt atomically with a later base, and late evidence cannot move it back (A31)", () => {
    const incoming = { commit: oid("5"), tree: oid("6"), generation: 2 };
    // An incoming-only sync that leaves the old attempt unknown would let it rewind later.
    expect(violation(pending, { base: incoming })).toBe("unknown-attempt-not-superseded");
    const superseded = next(pending, {
      base: incoming,
      attempts: [attempt(1, { outcome: "superseded-unresolved", evidence: "superseded" })],
    });
    expect(overleafTransitionViolation(pending, superseded, NOW)).toBeNull();
    expect(
      violation(pending, {
        attempts: [attempt(1, { outcome: "superseded-unresolved", evidence: "superseded" })],
      }),
    ).toBe("superseded-without-base-change");
    // Late positive evidence is recorded, but the later base stands.
    expect(
      violation(superseded, {
        base: { commit: oid("c"), tree: oid("d"), generation: 3 },
        attempts: [attempt(1, { outcome: "accepted", evidence: "remote-history" })],
      }),
    ).toBe("late-evidence-moved-base");
    expect(
      violation(superseded, {
        attempts: [attempt(1, { outcome: "accepted", evidence: "remote-history" })],
      }),
    ).toBeNull();
    expect(violation(superseded, { attempts: [attempt(1)] })).toBe("attempt-outcome-not-allowed");
  });

  it("allows the coordinator's ordinary transitions", () => {
    const empty = overleafConnectionFixture();
    // First sync from an empty base, and a later incoming-only sync, with no attempts.
    const first = next(empty, {
      base: { commit: oid("1"), tree: oid("2"), generation: 1 },
      completedSyncCount: 1,
    });
    expect(overleafTransitionViolation(empty, first, NOW)).toBeNull();
    const link = {
      applyId: "apply-1",
      kind: "sync-apply" as const,
      operationId: "operation-1",
      planDigest: "a".repeat(64),
      baseGeneration: 1,
      intentTree: oid("5"),
      remoteCommit: oid("7"),
      localOnly: [],
      priorMarkers: [],
      markers: [],
    };
    const applying = next(first, { activeApply: link });
    // The apply's result advances the base and clears its link in one replacement.
    const applied = next(applying, {
      activeApply: null,
      base: { commit: null, tree: oid("6"), generation: 2 },
      completedSyncCount: 2,
    });
    expect(overleafTransitionViolation(applying, applied, NOW)).toBeNull();
    // A refused send, then a fresh attempt on the same base.
    const recorded = next(applied, {
      lastAttemptNumber: 1,
      attempts: [attempt(1, { baseGeneration: 2 })],
    });
    const refused = next(recorded, {
      attempts: [attempt(1, { baseGeneration: 2, outcome: "not-sent", evidence: "send-refused" })],
    });
    expect(overleafTransitionViolation(recorded, refused, NOW)).toBeNull();
    const retry = next(refused, {
      lastAttemptNumber: 2,
      attempts: [...refused.attempts, attempt(2, { baseGeneration: 2 })],
    });
    expect(overleafTransitionViolation(refused, retry, NOW)).toBeNull();
    // A superseded attempt stays kept through further base changes.
    const superseded = next(retry, {
      base: { commit: oid("7"), tree: oid("8"), generation: 3 },
      attempts: [
        refused.attempts[0]!,
        attempt(2, { baseGeneration: 2, outcome: "superseded-unresolved", evidence: "superseded" }),
      ],
    });
    expect(overleafTransitionViolation(retry, superseded, NOW)).toBeNull();
    expect(
      violation(superseded, { base: { commit: oid("9"), tree: oid("a"), generation: 4 } }),
    ).toBeNull();
  });

  it("bounds unresolved attempts in the document itself", () => {
    const attempts = Array.from({ length: 17 }, (_, index) => attempt(index + 1));
    expect(isValid({ ...synced, lastAttemptNumber: 16, attempts: attempts.slice(0, 16) })).toBe(
      true,
    );
    expect(isValid({ ...synced, lastAttemptNumber: 17, attempts })).toBe(false);
  });

  it("keeps a pending apply intent identical until it is cleared", () => {
    const link = {
      applyId: "apply-1",
      kind: "sync-apply" as const,
      operationId: "operation-1",
      planDigest: "a".repeat(64),
      baseGeneration: 1,
      intentTree: oid("5"),
      remoteCommit: oid("7"),
      localOnly: [],
      priorMarkers: [],
      markers: [],
    };
    const applying = next(synced, { activeApply: link });
    expect(overleafTransitionViolation(synced, applying, NOW)).toBeNull();
    expect(violation(applying, { activeApply: { ...link, intentTree: oid("6") } })).toBe(
      "apply-link-changed",
    );
    expect(violation(applying, { activeApply: { ...link, applyId: "apply-2" } })).toBe(
      "apply-link-changed",
    );
    expect(violation(applying, { activeApply: { ...link } })).toBeNull();
    expect(violation(applying, { activeApply: null })).toBeNull();
  });

  it("keeps the accepted attempt a pending undo names", () => {
    const accepted = attempt(1, {
      parentCommit: oid("1"),
      candidateCommit: oid("3"),
      candidateTree: oid("4"),
      outcome: "accepted",
      evidence: "push-accepted",
    });
    const sent = next(synced, {
      base: { commit: oid("3"), tree: oid("4"), generation: 2 },
      lastAttemptNumber: 1,
      attempts: [accepted],
    });
    const link = {
      applyId: "apply-1",
      kind: "sync-undo" as const,
      operationId: "operation-1",
      planDigest: "a".repeat(64),
      baseGeneration: 2,
      intentTree: oid("5"),
      remoteCommit: oid("3"),
      localOnly: [],
      priorMarkers: [],
      markers: [],
      undoneAttempt: 1,
    };
    expect(isValid({ ...sent, activeApply: link })).toBe(true);
    // Only an undo names an attempt, and it must name one recorded as accepted.
    const { undoneAttempt: _, ...unnamed } = link;
    expect(isValid({ ...sent, activeApply: unnamed })).toBe(false);
    expect(isValid({ ...sent, activeApply: { ...link, kind: "retained-restore" } })).toBe(false);
    expect(isValid({ ...sent, activeApply: { ...link, undoneAttempt: 2 } })).toBe(false);
    // Only an undo retires managed paths.
    expect(isValid({ ...sent, activeApply: { ...link, retired: ["main.tex"] } })).toBe(true);
    expect(isValid({ ...sent, activeApply: { ...unnamed, kind: "sync-apply", retired: [] } })).toBe(
      false,
    );
    expect(isValid({ ...sent, activeApply: link, attempts: [] })).toBe(false);
    expect(
      isValid({
        ...sent,
        activeApply: link,
        attempts: [{ ...accepted, outcome: "out-of-date", evidence: "push-out-of-date" }],
      }),
    ).toBe(false);
  });

  it("upgrades a version 1 document with a pending undo, keeping what it undoes", () => {
    const accepted = attempt(1, {
      parentCommit: oid("1"),
      candidateCommit: oid("3"),
      candidateTree: oid("4"),
      outcome: "accepted",
      evidence: "push-accepted",
    });
    const { markers: _markers, ...rest } = next(synced, {
      base: { commit: oid("3"), tree: oid("4"), generation: 2 },
      lastAttemptNumber: 1,
      attempts: [accepted],
    });
    const link = {
      applyId: "apply-1",
      kind: "sync-undo" as const,
      operationId: "operation-1",
      planDigest: "a".repeat(64),
      baseGeneration: 2,
      intentTree: oid("5"),
      remoteCommit: oid("3"),
      localOnly: [],
      undoneAttempt: 1,
      retired: ["added.tex"],
    };
    const upgraded = decodeOverleafConnectionDocument(
      JSON.stringify({
        ...rest,
        schemaVersion: 1,
        markerPaths: ["main.tex"],
        activeApply: { ...link, priorMarkers: ["main.tex"] },
      }),
    );
    expect(upgraded?.activeApply).toEqual({
      ...link,
      priorMarkers: [{ path: "main.tex", links: null }],
      markers: [{ path: "main.tex", folderPaths: [], overleafPaths: ["main.tex"] }],
    });
  });

  it("refuses a fresh vault while the connection still references the recorded one", () => {
    const freshVault = {
      ...synced.retention,
      vaultIdentity: { ...synced.retention.vaultIdentity, fileId: "99" },
    };
    const copy: OverleafConnectionDocument["retention"]["copies"][number] = {
      applyId: "apply-1",
      relativePath: "main.tex",
      revision: "r1",
      state: "changed",
      retainedAt: "2026-10-12T12:00:00.000Z",
      retainedAtSyncCount: 1,
      kept: "apply-1/files/step-0/retained",
      markers: false,
      markerLinks: [],
      versions: [],
      stamp: "1:1",
    };
    const holding = next(synced, { retention: { ...synced.retention, copies: [copy] } });
    expect(violation(holding, { retention: { ...freshVault, copies: [copy] } })).toBe(
      "vault-replaced-while-referenced",
    );
    expect(
      violation(holding, {
        retention: {
          ...holding.retention,
          vaultIdentity: { ...holding.retention.vaultIdentity, platform: "darwin", version: 1 },
        },
      }),
    ).toBeNull();

    const applying = next(synced, {
      activeApply: {
        applyId: "apply-1",
        kind: "sync-apply",
        operationId: "operation-1",
        planDigest: "a".repeat(64),
        baseGeneration: 1,
        intentTree: oid("5"),
        remoteCommit: oid("7"),
        localOnly: [],
        priorMarkers: [],
        markers: [],
      },
    });
    expect(violation(applying, { retention: freshVault })).toBe("vault-replaced-while-referenced");
    expect(violation(applying, { retention: freshVault, activeApply: null })).toBe(
      "vault-replaced-while-referenced",
    );

    // Nothing lives in the recorded vault, so a missing one may be replaced.
    expect(violation(synced, { retention: freshVault })).toBeNull();
  });

  it("keeps retained copies until seven days and a later completed sync, and never rewrites them", () => {
    const copy: OverleafConnectionDocument["retention"]["copies"][number] = {
      applyId: "apply-1",
      relativePath: "main.tex",
      revision: "r1",
      state: "releasable",
      retainedAt: "2026-10-05T12:00:00.000Z",
      retainedAtSyncCount: 1,
      kept: "apply-1/files/step-0/retained",
      markers: false,
      markerLinks: [],
      versions: [],
      stamp: "1:1",
    };
    const holding = (change: Partial<typeof copy>, completedSyncCount: number) =>
      next(synced, {
        completedSyncCount,
        retention: { ...synced.retention, copies: [{ ...copy, ...change }] },
      });
    const drop = (from: OverleafConnectionDocument) =>
      violation(from, { retention: { ...from.retention, copies: [] } });

    expect(overleafRetainedCopyReleasable(copy, 2, NOW)).toBe(true);
    expect(drop(holding({}, 2))).toBeNull();
    expect(drop(holding({}, 1))).toBe("retained-copy-dropped");
    expect(drop(holding({ retainedAt: "2026-10-07T12:00:00.000Z" }, 2))).toBe(
      "retained-copy-dropped",
    );
    expect(drop(holding({ state: "changed" }, 2))).toBe("retained-copy-dropped");

    const changed = holding({ state: "changed", retainedAt: "2026-10-12T12:00:00.000Z" }, 2);
    expect(
      violation(changed, {
        retention: {
          ...changed.retention,
          copies: [{ ...copy, state: "releasable", retainedAt: "2026-10-12T12:00:00.000Z" }],
        },
      }),
    ).toBe("retained-copy-rewritten");
    expect(
      violation(changed, {
        retention: { ...changed.retention, copies: [{ ...copy, state: "changed" }] },
      }),
    ).toBe("retained-copy-rewritten"); // The other paths a kept copy of conflict material remembers never change.
    const kept = holding({ state: "kept", markers: true, markerLinks: ["old.tex"] }, 2);
    expect(
      violation(kept, {
        retention: {
          ...kept.retention,
          copies: [{ ...kept.retention.copies[0]!, markerLinks: [] }],
        },
      }),
    ).toBe("retained-copy-rewritten");
    // Unknown other paths (version 1) never become known, not even as none.
    const unknown = holding({ state: "kept", markers: true, markerLinks: null }, 2);
    expect(
      violation(unknown, {
        retention: {
          ...unknown.retention,
          copies: [{ ...unknown.retention.copies[0]!, markerLinks: [] }],
        },
      }),
    ).toBe("retained-copy-rewritten");
  });
});

describe("overleafRequiredPins", () => {
  it.effect("names refs that a real private repository can hold and report missing", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "scient-overleaf-pins-" });
        const git = yield* OverleafGitExecutor.make({
          runtimeRoot: NodePath.join(root, "runtime"),
          allowLocalProtocols: true,
        });
        const repos = yield* OverleafRepository.make.pipe(
          Effect.provideService(OverleafGitExecutor.OverleafGitExecutor, git),
        );
        const repo = NodePath.join(root, "repo.git");
        yield* repos.initialize({
          repo,
          gitUrl: "https://git.overleaf.com/0123456789abcdef01234567",
        });
        const blob = yield* repos.writeBlob({ repo, bytes: new TextEncoder().encode("x") });
        const tree = yield* repos.writeTree({ repo, entries: [{ path: "main.tex", oid: blob }] });
        const commit = yield* repos.commit({ repo, tree, parents: [], message: "base" });
        const document: OverleafConnectionDocument = {
          ...synced,
          base: { commit, tree, generation: 3 },
          localSnapshots: [{ sequence: 1, commit: null, tree }],
          lastAttemptNumber: 1,
          attempts: [
            attempt(1, { parentCommit: commit, candidateCommit: commit, baseGeneration: 3 }),
          ],
        };
        const pins = overleafRequiredPins(document);
        expect(pins.map((pin) => pin.name)).toEqual([
          "base/3/tree",
          "base/3/commit",
          "local/1/tree",
          "attempt/1/candidate",
          "attempt/1/parent",
        ]);
        for (const pin of pins.slice(0, 4)) yield* repos.setRef({ repo, ...pin });
        const found = yield* Effect.forEach(pins, (pin) => repos.readRef({ repo, name: pin.name }));
        expect(found).toEqual([tree, commit, tree, commit, null]);
        // An accepted attempt keeps its commits for Undo; one settled otherwise does not.
        const names = (outcome: Pick<OverleafPublicationAttempt, "outcome" | "evidence">) =>
          overleafRequiredPins({
            ...document,
            attempts: [attempt(1, { parentCommit: commit, candidateCommit: commit, ...outcome })],
          })
            .map((pin) => pin.name)
            .filter((name) => name.startsWith("attempt/"));
        expect(names({ outcome: "accepted", evidence: "push-accepted" })).toEqual([
          "attempt/1/candidate",
          "attempt/1/parent",
        ]);
        expect(names({ outcome: "out-of-date", evidence: "push-out-of-date" })).toEqual([]);
        expect(names({ outcome: "not-sent", evidence: "send-refused" })).toEqual([]);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
});
