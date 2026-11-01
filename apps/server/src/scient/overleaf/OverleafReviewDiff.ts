import type { ScientOverleafDiffFile, ScientOverleafDiffResult } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { OVERLEAF_LIMITS } from "./OverleafInventory.ts";
import type { OverleafRepository } from "./OverleafRepository.ts";
import type { OverleafReview } from "./OverleafReview.ts";

function decodeText(bytes: Uint8Array): string | null {
  if (bytes.includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

type PlannedFile =
  | Extract<ScientOverleafDiffFile, { _tag: "not-shown" }>
  | {
      readonly _tag: "pair";
      readonly path: string;
      readonly before: string | null;
      readonly after: string | null;
    };

/** Read immutable review objects only; no fetch, capture, recovery or repository initialization. */
export const readOverleafReviewDiff = Effect.fn("OverleafReviewDiff.read")(function* (
  repos: OverleafRepository["Service"],
  repo: string,
  review: OverleafReview,
) {
  const tree = Effect.fn("OverleafReviewDiff.tree")(function* (oid: string | null) {
    if (oid === null) return new Map<string, { oid: string; size: number }>();
    const entries = yield* repos.readTree({ repo, tree: oid });
    const sizes = yield* repos.treeSizes({ repo, tree: oid });
    return new Map(
      entries.map((entry) => [
        entry.path,
        { oid: entry.oid, size: sizes.get(entry.path) ?? Infinity },
      ]),
    );
  });
  const base = yield* tree(review.binding.baseTree);
  const remote = yield* tree(review.binding.remoteTree);
  const publication = yield* tree(review.binding.publicationTree);
  let remaining = OVERLEAF_LIMITS.editableTotalBytes;
  const wanted = new Set<string>();
  const group = (after: typeof base): PlannedFile[] => {
    const files: PlannedFile[] = [];
    const paths = [...new Set([...base.keys(), ...after.keys()])].sort();
    for (const path of paths) {
      const beforeEntry = base.get(path);
      const afterEntry = after.get(path);
      if (beforeEntry?.oid === afterEntry?.oid) continue;
      const size = (beforeEntry?.size ?? 0) + (afterEntry?.size ?? 0);
      if (size > OVERLEAF_LIMITS.previewBytes) {
        files.push({ _tag: "not-shown", path, reason: "file-too-large" });
        continue;
      }
      if (size > remaining) {
        files.push({ _tag: "not-shown", path, reason: "total-limit" });
        continue;
      }
      remaining -= size;
      if (beforeEntry !== undefined) wanted.add(beforeEntry.oid);
      if (afterEntry !== undefined) wanted.add(afterEntry.oid);
      files.push({
        _tag: "pair",
        path,
        before: beforeEntry?.oid ?? null,
        after: afterEntry?.oid ?? null,
      });
    }
    return files;
  };
  const incoming = group(remote);
  const outgoing = group(publication);
  const oids = [...wanted];
  const blobs = yield* repos.readBlobs({
    repo,
    oids,
    maxBytes: OVERLEAF_LIMITS.previewBytes,
    maxTotalBytes: OVERLEAF_LIMITS.editableTotalBytes,
  });
  const contents = new Map(oids.map((oid, index) => [oid, decodeText(blobs[index]!)]));
  const render = (files: PlannedFile[]): ScientOverleafDiffFile[] =>
    files.map((file) => {
      if (file._tag === "not-shown") return file;
      const before = file.before === null ? null : contents.get(file.before)!;
      const after = file.after === null ? null : contents.get(file.after)!;
      return (file.before !== null && before === null) || (file.after !== null && after === null)
        ? { _tag: "not-shown", path: file.path, reason: "binary" }
        : { _tag: "text", path: file.path, before, after };
    });
  return {
    _tag: "diff",
    reviewId: review.id,
    incoming: render(incoming),
    outgoing: render(outgoing),
  } satisfies ScientOverleafDiffResult;
});
