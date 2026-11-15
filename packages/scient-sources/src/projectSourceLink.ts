// @effect-diagnostics nodeBuiltinImport:off -- Linking reads and writes project and library files.
import * as NodeFSP from "node:fs/promises";

import {
  linkScientProjectSource,
  readScientProjectSourceLink,
  unlinkScientProjectSource,
  type ScientProjectSourceLinkResult,
} from "./libraryInstanceMap.ts";
import { scientLibraryReviewsInternals } from "./libraryReviews.ts";
import type { ScientLibraryLocation } from "./libraryRoot.ts";
import type { ScientSourceActor } from "./model.ts";
import { scientProjectPinsInternals, withScientProjectPinsLock } from "./projectPins.ts";
import { scientSourceStoreInternals } from "./store.ts";

/** Review files, then pins, as the move takes them; the Library lock is taken inside. */
const withProjectFiles = <A>(root: string, run: () => Promise<A>) =>
  scientSourceStoreInternals.withOperationLock(`${root}:reviews-write`, () =>
    withScientProjectPinsLock(root, run),
  );

/**
 * Links a project source to a Library record on purpose and keeps what the project's files held
 * for it, so the link can be undone whole: the next refresh writes the linked record's data over
 * those copies.
 */
export async function linkScientProjectSourceKeepingCopies(input: {
  readonly library: ScientLibraryLocation;
  readonly projectRoot: string;
  readonly projectSourceId: string;
  readonly sourceId: string;
  readonly actor: ScientSourceActor;
}): Promise<ScientProjectSourceLinkResult> {
  const root = await NodeFSP.realpath(input.projectRoot);
  return withProjectFiles(root, async () =>
    linkScientProjectSource({
      ...input,
      replacedCopies: {
        pin: await scientProjectPinsInternals.readPinCopy(root, input.projectSourceId),
        reviews: await scientLibraryReviewsInternals.readEntryCopies(root, input.projectSourceId),
      },
    }),
  );
}

/**
 * Undoes a link: the saved copies go back first, then the link. A stop in between leaves the
 * source linked with its copies still kept, and the next refresh makes it fully linked again.
 */
export async function unlinkScientProjectSourceRestoringCopies(input: {
  readonly library: ScientLibraryLocation;
  readonly projectRoot: string;
  readonly projectSourceId: string;
  readonly actor: ScientSourceActor;
}): Promise<{ readonly outcome: "unlinked" | "not-linked" }> {
  const root = await NodeFSP.realpath(input.projectRoot);
  return withProjectFiles(root, async () => {
    const link = await readScientProjectSourceLink(input);
    if (!link) return { outcome: "not-linked" as const };
    const copies = link.replacedCopies;
    if (typeof copies === "object" && copies !== null) {
      const { pin, reviews } = copies as { readonly pin?: unknown; readonly reviews?: unknown };
      await scientProjectPinsInternals.writePinCopy(root, input.projectSourceId, pin);
      await scientLibraryReviewsInternals.writeEntryCopies(root, input.projectSourceId, reviews);
    }
    return unlinkScientProjectSource(input);
  });
}
