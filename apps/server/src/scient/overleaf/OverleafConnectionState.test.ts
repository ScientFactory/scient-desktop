// @effect-diagnostics nodeBuiltinImport:off -- Builds a throwaway repository with real Git.
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as NodeServices from "@effect/platform-node/NodeServices";

import {
  type OverleafConnectionDocument,
  type OverleafPublicationAttempt,
  overleafRequiredPins,
  overleafTransitionViolation,
  retainedCopyReleasable,
} from "./OverleafConnectionState.ts";
import * as OverleafGitExecutor from "./OverleafGitExecutor.ts";
import * as OverleafRepository from "./OverleafRepository.ts";
import { overleafConnectionFixture } from "./OverleafConnectionState.testkit.ts";

const NOW = Date.parse("2026-10-13T12:00:00.000Z");
const oid = (digit: string) => digit.repeat(40);

const attempt = (
  attemptNumber: number,
  outcome: OverleafPublicationAttempt["outcome"],
): OverleafPublicationAttempt => ({
  attemptNumber,
  operationId: `operation-${attemptNumber}`,
  requestId: `request-${attemptNumber}`,
  planDigest: "a".repeat(64),
  branch: "main",
  parentCommit: oid("1"),
  candidateCommit: oid(String(attemptNumber + 1)),
  candidateTree: oid("9"),
  baseGeneration: 1,
  outcome,
  evidence: outcome === "unknown" ? null : "push-accepted",
  recordedAt: "2026-10-13T11:00:00.000Z",
});

const next = (
  previous: OverleafConnectionDocument,
  change: Partial<OverleafConnectionDocument>,
): OverleafConnectionDocument => ({ ...previous, revision: previous.revision + 1, ...change });

describe("overleafTransitionViolation", () => {
  const base = overleafConnectionFixture();

  it("accepts an ordinary next revision and refuses skipped or repeated revisions", () => {
    expect(overleafTransitionViolation(base, next(base, {}), NOW)).toBeNull();
    expect(overleafTransitionViolation(base, { ...base }, NOW)).toBe("revision-not-next");
    expect(overleafTransitionViolation(base, { ...base, revision: 3 }, NOW)).toBe(
      "revision-not-next",
    );
  });

  it("never rewinds or silently rewrites the base", () => {
    const advanced = next(base, { base: { commit: oid("c"), tree: oid("d"), generation: 2 } });
    expect(overleafTransitionViolation(base, advanced, NOW)).toBeNull();
    // Late evidence about an older attempt cannot move the base backwards.
    expect(
      overleafTransitionViolation(
        advanced,
        next(advanced, { base: { commit: oid("e"), tree: oid("f"), generation: 1 } }),
        NOW,
      ),
    ).toBe("base-generation-decreased");
    expect(
      overleafTransitionViolation(
        base,
        next(base, { base: { ...base.base, tree: oid("f") } }),
        NOW,
      ),
    ).toBe("base-changed-without-generation");
  });

  it("refuses changing who the connection is", () => {
    expect(
      overleafTransitionViolation(
        base,
        next(base, { remote: { ...base.remote, projectId: "b".repeat(24) } }),
        NOW,
      ),
    ).toBe("identity-changed");
  });

  it("records a new attempt as unknown under a fresh number before any send", () => {
    const recorded = next(base, { lastAttemptNumber: 1, attempts: [attempt(1, "unknown")] });
    expect(overleafTransitionViolation(base, recorded, NOW)).toBeNull();
    expect(
      overleafTransitionViolation(
        base,
        next(base, { lastAttemptNumber: 1, attempts: [attempt(1, "accepted")] }),
        NOW,
      ),
    ).toBe("attempt-not-recorded-unknown");
    expect(
      overleafTransitionViolation(base, next(base, { attempts: [attempt(1, "unknown")] }), NOW),
    ).toBe("attempt-number-ahead");
    // A pruned attempt's number is never reused.
    const pruned = next(recorded, { attempts: [] });
    expect(
      overleafTransitionViolation({ ...recorded, attempts: [attempt(1, "accepted")] }, pruned, NOW),
    ).toBeNull();
    expect(
      overleafTransitionViolation(pruned, next(pruned, { attempts: [attempt(1, "unknown")] }), NOW),
    ).toBe("attempt-number-reused");
  });

  it("keeps unresolved publication evidence until positive evidence resolves it", () => {
    const unknown = next(base, { lastAttemptNumber: 1, attempts: [attempt(1, "unknown")] });
    expect(overleafTransitionViolation(unknown, next(unknown, { attempts: [] }), NOW)).toBe(
      "unresolved-attempt-dropped",
    );
    expect(
      overleafTransitionViolation(
        unknown,
        next(unknown, { attempts: [{ ...attempt(1, "unknown"), candidateCommit: oid("7") }] }),
        NOW,
      ),
    ).toBe("unresolved-attempt-rewritten");
    // Supersession preserves the attempt; it is not proof of rejection.
    const superseded = next(unknown, {
      base: { commit: oid("c"), tree: oid("d"), generation: 2 },
      attempts: [{ ...attempt(1, "superseded-unresolved"), evidence: "superseded" }],
    });
    expect(overleafTransitionViolation(unknown, superseded, NOW)).toBeNull();
    expect(
      overleafTransitionViolation(
        superseded,
        next(superseded, { attempts: [attempt(1, "unknown")] }),
        NOW,
      ),
    ).toBe("unresolved-attempt-rewritten");
    // Late positive evidence may resolve it, and then resolved history can be pruned.
    const resolved = next(superseded, { attempts: [attempt(1, "accepted")] });
    expect(overleafTransitionViolation(superseded, resolved, NOW)).toBeNull();
    expect(overleafTransitionViolation(resolved, next(resolved, { attempts: [] }), NOW)).toBeNull();
    expect(
      overleafTransitionViolation(
        resolved,
        next(resolved, {
          attempts: [{ ...attempt(1, "out-of-date"), evidence: "push-out-of-date" }],
        }),
        NOW,
      ),
    ).toBe("resolved-attempt-reopened");
  });

  it("refuses to accumulate unresolved attempts past the storage limit", () => {
    const attempts = Array.from({ length: 16 }, (_, index) => attempt(index + 1, "unknown"));
    const full = next(base, { lastAttemptNumber: 16, attempts });
    expect(overleafTransitionViolation(base, full, NOW)).toBeNull();
    expect(
      overleafTransitionViolation(
        full,
        next(full, { lastAttemptNumber: 17, attempts: [...attempts, attempt(17, "unknown")] }),
        NOW,
      ),
    ).toBe("unresolved-attempt-limit");
  });

  it("cannot swap one pending apply intent for another", () => {
    const link = {
      applyId: "apply-1",
      kind: "sync-apply" as const,
      operationId: "operation-1",
      planDigest: "a".repeat(64),
      baseGeneration: 1,
      intentTree: oid("5"),
    };
    const applying = next(base, { activeApply: link });
    expect(overleafTransitionViolation(base, applying, NOW)).toBeNull();
    expect(
      overleafTransitionViolation(
        applying,
        next(applying, { activeApply: { ...link, applyId: "apply-2" } }),
        NOW,
      ),
    ).toBe("apply-link-replaced");
    expect(
      overleafTransitionViolation(applying, next(applying, { activeApply: null }), NOW),
    ).toBeNull();
  });

  it("releases a retained copy only after seven days and a later completed sync", () => {
    const copy: OverleafConnectionDocument["retention"]["copies"][number] = {
      applyId: "apply-1",
      relativePath: "main.tex",
      revision: "r1",
      state: "releasable",
      retainedAt: "2026-10-05T12:00:00.000Z",
      laterSyncCompleted: true,
    };
    const withCopy = (state: typeof copy) =>
      next(base, { retention: { ...base.retention, copies: [state] } });
    const drop = (from: OverleafConnectionDocument) =>
      overleafTransitionViolation(
        from,
        next(from, { retention: { ...from.retention, copies: [] } }),
        NOW,
      );
    expect(retainedCopyReleasable(copy, NOW)).toBe(true);
    expect(drop(withCopy(copy))).toBeNull();
    expect(drop(withCopy({ ...copy, laterSyncCompleted: false }))).toBe("retained-copy-dropped");
    expect(drop(withCopy({ ...copy, retainedAt: "2026-10-07T12:00:00.000Z" }))).toBe(
      "retained-copy-dropped",
    );
    expect(drop(withCopy({ ...copy, state: "changed" }))).toBe("retained-copy-dropped");
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
          ...overleafConnectionFixture(),
          base: { commit, tree, generation: 3 },
          lastAttemptNumber: 1,
          attempts: [{ ...attempt(1, "unknown"), parentCommit: commit, candidateCommit: commit }],
        };
        const pins = overleafRequiredPins(document);
        expect(pins.map((pin) => pin.name)).toEqual([
          "base/3/tree",
          "base/3/commit",
          "attempt/1/candidate",
          "attempt/1/parent",
        ]);
        for (const pin of pins.slice(0, 3)) yield* repos.setRef({ repo, ...pin });
        const found = yield* Effect.forEach(pins, (pin) => repos.readRef({ repo, name: pin.name }));
        expect(found).toEqual([tree, commit, commit, null]);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
});
