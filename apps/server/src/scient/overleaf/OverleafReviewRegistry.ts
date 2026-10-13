/**
 * Reviews waiting for the user (coordinator contract sections 3 and 5).
 *
 * One current review per connection, for fifteen minutes, in memory only: a
 * restarted server has no reviews to replay. A confirmation consumes its review
 * once, and only if it names the current review's ID and digest and every
 * acknowledgement the review requires. Whether the world still matches is a
 * separate check: the caller builds the review again from a fresh capture and
 * fetch and compares the two.
 *
 * A review holds the bytes the applier would write, so the registry bounds how
 * many it keeps and how many bytes they hold, and drops expired reviews on
 * every call. `sweep` lets an owner with a timer drop them without a call.
 */
import {
  overleafReviewDigest,
  type OverleafReview,
  type OverleafReviewBinding,
} from "./OverleafReview.ts";

export const OVERLEAF_REVIEW_LIFETIME_MS = 15 * 60 * 1000;
/** At most this many reviews, holding at most this many target bytes, across connections. */
export const OVERLEAF_REVIEW_LIMITS = { reviews: 16, targetBytes: 512 * 1024 * 1024 };

export type OverleafReviewTakeRefusal =
  /** No review is waiting for this connection (none built, consumed, expired, or lost at restart). */
  | "unknown"
  /** A newer review replaced the one confirmed, or it was invalidated or evicted. */
  | "replaced"
  | "expired"
  /** The ID matches but the digest does not: not the review the user saw. */
  | "digest"
  /** The confirmation does not acknowledge every warning the review requires. */
  | "acknowledgements"
  /** A conflict has no choice yet. */
  | "unresolved";

export interface OverleafReviewRegistry {
  /** Makes `review` the connection's current review; any earlier one can no longer be confirmed. */
  readonly offer: (review: OverleafReview, now: number) => void;
  readonly current: (connectionId: string, now: number) => OverleafReview | null;
  readonly take: (input: {
    readonly connectionId: string;
    readonly id: string;
    readonly digest: string;
    readonly acknowledgements: ReadonlyArray<string>;
    readonly now: number;
  }) =>
    | { readonly _tag: "taken"; readonly review: OverleafReview }
    | { readonly _tag: "refused"; readonly reason: OverleafReviewTakeRefusal };
  /** Drops the connection's review, for example after token renewal or a checkout mutation. */
  readonly invalidate: (connectionId: string) => void;
  /** Drops expired reviews. Every other call does this too. */
  readonly sweep: (now: number) => void;
}

export function makeOverleafReviewRegistry(
  limits: typeof OVERLEAF_REVIEW_LIMITS = OVERLEAF_REVIEW_LIMITS,
): OverleafReviewRegistry {
  const reviews = new Map<string, { review: OverleafReview; offeredAt: number }>();
  /** Recently dropped review IDs, so a late confirmation can say why it failed. */
  const dropped = new Map<string, { id: string; reason: "replaced" | "expired" }[]>();
  const remember = (connectionId: string, id: string, reason: "replaced" | "expired") => {
    const ids = (dropped.get(connectionId) ?? []).filter((entry) => entry.id !== id);
    ids.push({ id, reason });
    dropped.set(connectionId, ids.slice(-32));
  };
  const drop = (connectionId: string, reason: "replaced" | "expired") => {
    const entry = reviews.get(connectionId);
    if (entry === undefined) return;
    reviews.delete(connectionId);
    remember(connectionId, entry.review.id, reason);
  };
  const sweep = (now: number) => {
    for (const [connectionId, entry] of reviews)
      if (now - entry.offeredAt >= OVERLEAF_REVIEW_LIFETIME_MS) drop(connectionId, "expired");
  };
  /** Evicts the oldest other reviews until the limits hold again. */
  const bound = (keep: string) => {
    const total = () =>
      [...reviews.values()].reduce((sum, entry) => sum + entry.review.targetBytes, 0);
    const oldest = () =>
      [...reviews]
        .filter(([connectionId]) => connectionId !== keep)
        .sort((left, right) => left[1].offeredAt - right[1].offeredAt)[0]?.[0];
    for (
      let victim = oldest();
      victim !== undefined && (reviews.size > limits.reviews || total() > limits.targetBytes);
      victim = oldest()
    )
      drop(victim, "replaced");
  };
  return {
    sweep,
    offer: (review, now) => {
      sweep(now);
      const connectionId = review.binding.connectionId;
      drop(connectionId, "replaced");
      reviews.set(connectionId, { review, offeredAt: now });
      bound(connectionId);
    },
    current: (connectionId, now) => {
      sweep(now);
      return reviews.get(connectionId)?.review ?? null;
    },
    take: (input) => {
      sweep(input.now);
      const review = reviews.get(input.connectionId)?.review;
      if (review === undefined || review.id !== input.id) {
        const known = dropped.get(input.connectionId)?.find((entry) => entry.id === input.id);
        return { _tag: "refused", reason: known?.reason ?? "unknown" };
      }
      if (review.digest !== input.digest) return { _tag: "refused", reason: "digest" };
      const given = new Set(input.acknowledgements);
      if (review.binding.acknowledgements.some((kind) => !given.has(kind)))
        return { _tag: "refused", reason: "acknowledgements" };
      if (!review.confirmable) return { _tag: "refused", reason: "unresolved" };
      // Consumed once: a repeated confirmation finds no review.
      reviews.delete(input.connectionId);
      return { _tag: "taken", review };
    },
    invalidate: (connectionId) => drop(connectionId, "replaced"),
  };
}

export type OverleafReviewStaleReason =
  | "connection-revision"
  | "base"
  | "checkout-epoch"
  | "credential-epoch"
  | "authority"
  | "folder"
  /** The folder no longer holds what was captured. */
  | "capture"
  /** Overleaf's head moved, even to a commit with the same tree. */
  | "remote"
  /** Additions, local-only decisions, collisions or recorded conflict material changed. */
  | "inventory"
  /** Anything else the review shows: candidate, conflicts, warnings, acknowledgements. */
  | "review";

/**
 * Why a review no longer describes the world, or null when it still does.
 * `fresh` is the binding of the same review built again, with the same
 * selections and choices, from a fresh capture and fetch under the current
 * connection. A stale review is never applied; `fresh` replaces it.
 */
export function overleafReviewStaleness(
  binding: OverleafReviewBinding,
  fresh: OverleafReviewBinding,
): OverleafReviewStaleReason | null {
  if (overleafReviewDigest(binding) === overleafReviewDigest(fresh)) return null;
  const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
  if (binding.connectionRevision !== fresh.connectionRevision) return "connection-revision";
  if (binding.baseGeneration !== fresh.baseGeneration || binding.baseTree !== fresh.baseTree)
    return "base";
  if (binding.checkoutEpoch !== fresh.checkoutEpoch) return "checkout-epoch";
  if (binding.credentialEpoch !== fresh.credentialEpoch) return "credential-epoch";
  if (
    binding.authority.bindingId !== fresh.authority.bindingId ||
    binding.authority.authorityGeneration !== fresh.authority.authorityGeneration ||
    binding.authority.scopeRevision !== fresh.authority.scopeRevision
  )
    return "authority";
  if (
    binding.folderIdentity.volume !== fresh.folderIdentity.volume ||
    binding.folderIdentity.fileId !== fresh.folderIdentity.fileId
  )
    return "folder";
  if (binding.localTree !== fresh.localTree) return "capture";
  if (binding.remoteCommit !== fresh.remoteCommit || binding.remoteTree !== fresh.remoteTree)
    return "remote";
  if (
    !same(binding.selectedAdditions, fresh.selectedAdditions) ||
    !same(binding.newLocalOnly, fresh.newLocalOnly) ||
    !same(binding.collisionPaths, fresh.collisionPaths) ||
    !same(binding.recordedMarkerPaths, fresh.recordedMarkerPaths) ||
    !same(binding.unresolvedMarkers, fresh.unresolvedMarkers)
  )
    return "inventory";
  return "review";
}
