/**
 * Reviews waiting for the user (coordinator contract sections 3 and 5).
 *
 * One current review per connection, for fifteen minutes, in memory only: a
 * restarted server has no reviews to replay. A confirmation consumes its review
 * once, and only if it names the current review's ID and digest and every
 * acknowledgement the review requires. Whether the world still matches the
 * review is a separate check, run again after capturing and fetching anew.
 */
import type { OverleafReview, OverleafReviewBinding } from "./OverleafReview.ts";

export const OVERLEAF_REVIEW_LIFETIME_MS = 15 * 60 * 1000;

export type OverleafReviewTakeRefusal =
  /** No review is waiting for this connection (none built, consumed, expired, or lost at restart). */
  | "unknown"
  /** A newer review replaced the one confirmed. */
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
}

export function makeOverleafReviewRegistry(): OverleafReviewRegistry {
  const reviews = new Map<string, { review: OverleafReview; offeredAt: number }>();
  /** IDs of reviews replaced by a newer one, so a late confirmation says why it failed. */
  const replaced = new Map<string, Set<string>>();
  const remember = (connectionId: string, id: string) => {
    const ids = replaced.get(connectionId) ?? new Set<string>();
    ids.add(id);
    // Bounded: only recent replacements need a precise reason.
    if (ids.size > 32) ids.delete(ids.values().next().value as string);
    replaced.set(connectionId, ids);
  };
  const live = (connectionId: string, now: number) => {
    const entry = reviews.get(connectionId);
    if (entry === undefined) return null;
    if (now - entry.offeredAt >= OVERLEAF_REVIEW_LIFETIME_MS) return { expired: entry.review };
    return { review: entry.review };
  };
  return {
    offer: (review, now) => {
      const connectionId = review.binding.connectionId;
      const earlier = reviews.get(connectionId);
      if (earlier !== undefined) remember(connectionId, earlier.review.id);
      reviews.set(connectionId, { review, offeredAt: now });
    },
    current: (connectionId, now) => {
      const state = live(connectionId, now);
      if (state === null) return null;
      if ("expired" in state) {
        reviews.delete(connectionId);
        return null;
      }
      return state.review;
    },
    take: (input) => {
      const state = live(input.connectionId, input.now);
      const known = state === null ? null : "review" in state ? state.review : state.expired;
      if (known === null || known.id !== input.id) {
        return {
          _tag: "refused",
          reason: replaced.get(input.connectionId)?.has(input.id) ? "replaced" : "unknown",
        };
      }
      if (state !== null && "expired" in state) {
        reviews.delete(input.connectionId);
        return { _tag: "refused", reason: "expired" };
      }
      if (known.digest !== input.digest) return { _tag: "refused", reason: "digest" };
      const given = new Set(input.acknowledgements);
      if (known.binding.acknowledgements.some((kind) => !given.has(kind)))
        return { _tag: "refused", reason: "acknowledgements" };
      if (!known.confirmable) return { _tag: "refused", reason: "unresolved" };
      // Consumed once: a repeated confirmation finds no review.
      reviews.delete(input.connectionId);
      return { _tag: "taken", review: known };
    },
    invalidate: (connectionId) => {
      const entry = reviews.get(connectionId);
      if (entry === undefined) return;
      reviews.delete(connectionId);
      remember(connectionId, entry.review.id);
    },
  };
}

export type OverleafReviewStaleReason =
  | "connection-revision"
  | "base"
  | "checkout-epoch"
  | "credential-epoch"
  | "authority"
  | "folder"
  /** The folder no longer holds what was captured, or the selection changed. */
  | "capture"
  /** Overleaf's head moved, even to a commit with the same tree. */
  | "remote";

/** The current facts a review is checked against before anything is applied. */
export interface OverleafReviewCurrent {
  readonly connectionRevision: number;
  readonly baseGeneration: number;
  readonly baseTree: string | null;
  readonly checkoutEpoch: number;
  readonly credentialEpoch: number;
  readonly authority: OverleafReviewBinding["authority"];
  readonly folderIdentity: OverleafReviewBinding["folderIdentity"];
  /** Tree of a fresh capture with the review's selections. */
  readonly localTree: string;
  /** Head commit of a fresh fetch. */
  readonly remoteCommit: string;
}

/**
 * Why a review no longer describes the world, or null when it still does. A
 * stale review is never applied; the caller builds a replacement review.
 */
export function overleafReviewStaleness(
  binding: OverleafReviewBinding,
  current: OverleafReviewCurrent,
): OverleafReviewStaleReason | null {
  if (binding.connectionRevision !== current.connectionRevision) return "connection-revision";
  if (binding.baseGeneration !== current.baseGeneration || binding.baseTree !== current.baseTree)
    return "base";
  if (binding.checkoutEpoch !== current.checkoutEpoch) return "checkout-epoch";
  if (binding.credentialEpoch !== current.credentialEpoch) return "credential-epoch";
  if (
    binding.authority.bindingId !== current.authority.bindingId ||
    binding.authority.authorityGeneration !== current.authority.authorityGeneration ||
    binding.authority.scopeRevision !== current.authority.scopeRevision
  )
    return "authority";
  if (
    binding.folderIdentity.volume !== current.folderIdentity.volume ||
    binding.folderIdentity.fileId !== current.folderIdentity.fileId
  )
    return "folder";
  if (binding.localTree !== current.localTree) return "capture";
  if (binding.remoteCommit !== current.remoteCommit) return "remote";
  return null;
}
