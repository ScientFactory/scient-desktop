import { describe, expect, it } from "@effect/vitest";

import type { OverleafReview, OverleafReviewBinding } from "./OverleafReview.ts";
import {
  makeOverleafReviewRegistry,
  OVERLEAF_REVIEW_LIFETIME_MS,
  overleafReviewStaleness,
  type OverleafReviewCurrent,
} from "./OverleafReviewRegistry.ts";

const binding: OverleafReviewBinding = {
  connectionId: "connection-1",
  connectionRevision: 3,
  baseGeneration: 2,
  baseTree: "a".repeat(40),
  checkoutEpoch: 5,
  credentialEpoch: 1,
  authority: { bindingId: "binding-1", authorityGeneration: 1, scopeRevision: 1 },
  folderIdentity: { volume: "0A1B2C3D-0000-4000-8000-000000000001", fileId: "3" },
  localTree: "b".repeat(40),
  remoteCommit: "c".repeat(40),
  remoteTree: "d".repeat(40),
  selectedAdditions: [],
  newLocalOnly: [],
  choices: [],
  interrupted: [],
  candidateTree: "e".repeat(40),
  conflictKeys: [],
  markerPaths: [],
  warnings: [{ kind: "rename", from: "a.tex", to: "b.tex" }],
  acknowledgements: ["rename"],
};
const review = (id: string, change: Partial<OverleafReview> = {}): OverleafReview =>
  ({
    id,
    digest: `digest-${id}`,
    binding,
    confirmable: true,
    ...change,
  }) as OverleafReview;
const take = (
  registry: ReturnType<typeof makeOverleafReviewRegistry>,
  id: string,
  now = 0,
  change: { digest?: string; acknowledgements?: ReadonlyArray<string> } = {},
) =>
  registry.take({
    connectionId: "connection-1",
    id,
    digest: change.digest ?? `digest-${id}`,
    acknowledgements: change.acknowledgements ?? ["rename"],
    now,
  });

describe("makeOverleafReviewRegistry", () => {
  it("lets a review be confirmed exactly once", () => {
    const registry = makeOverleafReviewRegistry();
    registry.offer(review("r1"), 0);
    expect(registry.current("connection-1", 0)?.id).toBe("r1");
    expect(take(registry, "r1")).toMatchObject({ _tag: "taken", review: { id: "r1" } });
    expect(take(registry, "r1")).toEqual({ _tag: "refused", reason: "unknown" });
    expect(registry.current("connection-1", 0)).toBeNull();
  });

  it("refuses a review a newer one replaced, and keeps the newer one", () => {
    const registry = makeOverleafReviewRegistry();
    registry.offer(review("r1"), 0);
    registry.offer(review("r2"), 1);
    expect(take(registry, "r1", 2)).toEqual({ _tag: "refused", reason: "replaced" });
    expect(take(registry, "r2", 2)._tag).toBe("taken");
  });

  it("expires a review after fifteen minutes", () => {
    const registry = makeOverleafReviewRegistry();
    registry.offer(review("r1"), 0);
    expect(take(registry, "r1", OVERLEAF_REVIEW_LIFETIME_MS)).toEqual({
      _tag: "refused",
      reason: "expired",
    });
    registry.offer(review("r2"), 0);
    expect(registry.current("connection-1", OVERLEAF_REVIEW_LIFETIME_MS - 1)?.id).toBe("r2");
    expect(registry.current("connection-1", OVERLEAF_REVIEW_LIFETIME_MS)).toBeNull();
  });

  it("refuses a wrong digest, missing acknowledgements or open conflicts without consuming", () => {
    const registry = makeOverleafReviewRegistry();
    registry.offer(review("r1"), 0);
    expect(take(registry, "r1", 0, { digest: "other" })).toEqual({
      _tag: "refused",
      reason: "digest",
    });
    expect(take(registry, "r1", 0, { acknowledgements: [] })).toEqual({
      _tag: "refused",
      reason: "acknowledgements",
    });
    expect(take(registry, "r1")._tag).toBe("taken");

    registry.offer(review("r2", { confirmable: false }), 0);
    expect(take(registry, "r2")).toEqual({ _tag: "refused", reason: "unresolved" });
  });

  it("drops a review on invalidation, for example after token renewal", () => {
    const registry = makeOverleafReviewRegistry();
    registry.offer(review("r1"), 0);
    registry.invalidate("connection-1");
    expect(take(registry, "r1")).toEqual({ _tag: "refused", reason: "replaced" });
  });
});

describe("overleafReviewStaleness", () => {
  const current: OverleafReviewCurrent = {
    connectionRevision: binding.connectionRevision,
    baseGeneration: binding.baseGeneration,
    baseTree: binding.baseTree,
    checkoutEpoch: binding.checkoutEpoch,
    credentialEpoch: binding.credentialEpoch,
    authority: binding.authority,
    folderIdentity: binding.folderIdentity,
    localTree: binding.localTree,
    remoteCommit: binding.remoteCommit,
  };

  it("accepts a review that still matches everything it was built from", () => {
    expect(overleafReviewStaleness(binding, current)).toBeNull();
  });

  it.each([
    ["connection-revision", { connectionRevision: 4 }],
    ["base", { baseGeneration: 3 }],
    ["base", { baseTree: "f".repeat(40) }],
    ["checkout-epoch", { checkoutEpoch: 6 }],
    ["credential-epoch", { credentialEpoch: 2 }],
    ["authority", { authority: { ...binding.authority, scopeRevision: 2 } }],
    ["folder", { folderIdentity: { ...binding.folderIdentity, fileId: "9" } }],
    ["capture", { localTree: "f".repeat(40) }],
    // A new Overleaf commit with the same tree still changes the parent and the evidence.
    ["remote", { remoteCommit: "f".repeat(40) }],
  ] as const)("reports %s", (reason, change) => {
    expect(overleafReviewStaleness(binding, { ...current, ...change })).toBe(reason);
  });
});
