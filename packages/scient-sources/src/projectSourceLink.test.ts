// @effect-diagnostics nodeBuiltinImport:off -- Link tests exercise real project and library folders.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { initializeScientProject } from "@scientfactory/project-init";
import { afterEach, describe, expect, it } from "@effect/vitest";

import {
  changeScientLibraryReview,
  readScientReviewSnapshotEntries,
  refreshScientLibraryReviewSnapshot,
} from "./libraryReviews.ts";
import { ensureScientLibrary, scientLibraryLocation, scientLibraryRootFor } from "./libraryRoot.ts";
import type { ScientSourceCandidate } from "./model.ts";
import {
  pinScientLibrarySource,
  readScientProjectPins,
  refreshScientProjectPinSnapshots,
  resolveScientProjectPins,
} from "./projectPins.ts";
import {
  linkScientProjectSourceKeepingCopies,
  unlinkScientProjectSourceRestoringCopies,
} from "./projectSourceLink.ts";
import { importScientSource, readScientSourceRecord, removeScientSource } from "./store.ts";

const fixtures: string[] = [];

afterEach(async () => {
  await Promise.all(
    fixtures.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});

type Library = ReturnType<typeof scientLibraryLocation>;

const work = (title: string, sourceKey = title): ScientSourceCandidate => ({
  sourceKey,
  type: "article",
  customType: null,
  title,
  creators: [
    { creatorType: "author", givenName: "Ada", familyName: "Lovelace", literalName: null },
  ],
  issuedRaw: "2020",
  issuedYear: 2020,
  identifiers: [{ scheme: "doi", value: "10.1000/shared" }],
  abstract: `Abstract of ${title}.`,
  containerTitle: "Journal",
  publisher: null,
  volume: null,
  issue: null,
  pages: null,
  language: null,
  url: null,
  tags: [],
  externalReferences: [],
  fieldProvenance: [],
  pdfAvailable: false,
  pdfFileName: null,
  pdfAttachmentCount: 0,
});

/** A project citing a paper from its author's Library, opened with a collaborator's Library. */
async function collaboratorCheckout() {
  const base = await NodeFSP.realpath(
    await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-source-link-")),
  );
  fixtures.push(base);
  const newLibrary = async (name: string): Promise<Library> => {
    const root = scientLibraryRootFor(NodePath.join(base, name));
    await ensureScientLibrary(root);
    return scientLibraryLocation(root);
  };
  const add = async (to: Library, candidate: ScientSourceCandidate, refused: string[] = []) =>
    (
      await importScientSource({
        root: to,
        operationId: NodeCrypto.randomUUID(),
        candidate,
        refusedSourceIds: refused,
      })
    ).record!;
  const author = await newLibrary("author");
  const project = NodePath.join(base, "project");
  await NodeFSP.mkdir(project);
  await initializeScientProject({ root: project });
  const cited = await add(author, work("The cited study"));
  await pinScientLibrarySource({
    projectRoot: project,
    library: author,
    sourceId: cited.sourceId,
    actor: "user",
  });
  const library = await newLibrary("collaborator");
  const repair = { library, projectRoot: project, projectSourceId: cited.sourceId };
  /** What the server does after a change: resolve, then refresh the saved copies. */
  const refreshed = async () => {
    const [resolved] = await resolveScientProjectPins({
      projectRoot: project,
      library,
      mode: "write",
      actor: "user",
    });
    await refreshScientProjectPinSnapshots({ projectRoot: project, library });
    return { resolution: resolved!.resolution, pin: (await readScientProjectPins(project))[0]! };
  };
  return { author, project, cited, library, repair, add, refreshed };
}

describe("a deliberate link", () => {
  // regression: Unlink did nothing once a refresh had written the linked record into the copy.
  it("is undone whole: the saved copy is back and the record does not link again by itself", async () => {
    const { library, repair, add, refreshed } = await collaboratorCheckout();
    // The same DOI under another title: the automatic steps refuse it.
    const other = await add(library, work("A different title", "other"));
    expect((await refreshed()).resolution).toMatchObject({ reason: "contradicted" });

    await linkScientProjectSourceKeepingCopies({
      ...repair,
      sourceId: other.sourceId,
      actor: "user",
    });
    expect(await refreshed()).toMatchObject({
      resolution: { kind: "resolved", sourceId: other.sourceId },
      pin: { work: { title: "A different title" } },
    });

    expect(await unlinkScientProjectSourceRestoringCopies({ ...repair, actor: "user" })).toEqual({
      outcome: "unlinked",
    });
    for (const _again of [1, 2]) {
      expect(await refreshed()).toMatchObject({
        resolution: { reason: "contradicted", keptSeparate: true },
        pin: { work: { title: "The cited study" } },
      });
    }
  });

  // The restored copy alone would match the one record left; unlinking it must still hold.
  it("stays undone when the other candidate has gone meanwhile", async () => {
    const { library, repair, add, refreshed } = await collaboratorCheckout();
    const first = await add(library, work("The cited study", "first"));
    const second = await add(library, work("The cited study", "second"), [first.sourceId]);
    expect((await refreshed()).resolution).toMatchObject({ reason: "ambiguous" });

    await linkScientProjectSourceKeepingCopies({
      ...repair,
      sourceId: first.sourceId,
      actor: "user",
    });
    await refreshed();
    const gone = (await readScientSourceRecord(library, second.sourceId))!;
    await removeScientSource({
      root: library,
      sourceId: gone.sourceId,
      expectedRevision: gone.revision,
    });
    await unlinkScientProjectSourceRestoringCopies({ ...repair, actor: "user" });

    expect((await refreshed()).resolution).toMatchObject({
      kind: "unresolved",
      keptSeparate: true,
      candidateIds: [first.sourceId],
    });
  });

  it("puts a review's saved copy back too, for a record no pin names", async () => {
    const { author, project, library, add } = await collaboratorCheckout();
    const screened = await add(author, {
      ...work("Screened only", "screened"),
      identifiers: [{ scheme: "doi", value: "10.1000/screened" }],
    });
    const { reviewId } = await changeScientLibraryReview({
      projectRoot: project,
      library: author,
      change: { action: "create-review", title: "Review" },
      actor: "user",
    });
    await changeScientLibraryReview({
      projectRoot: project,
      library: author,
      change: { action: "add-sources", reviewId: reviewId!, sourceIds: [screened.sourceId] },
      actor: "user",
    });
    const other = await add(library, {
      ...work("Another title for it", "other-screened"),
      identifiers: [{ scheme: "doi", value: "10.1000/screened" }],
    });
    const repair = { library, projectRoot: project, projectSourceId: screened.sourceId };
    const entry = async () => {
      await refreshScientLibraryReviewSnapshot({
        projectRoot: project,
        library,
        reviewId: reviewId!,
      });
      return (await readScientReviewSnapshotEntries(project, reviewId!)).get(screened.sourceId);
    };

    await linkScientProjectSourceKeepingCopies({
      ...repair,
      sourceId: other.sourceId,
      actor: "agent",
    });
    expect(await entry()).toMatchObject({ title: "Another title for it" });
    // regression: review H1-d-1 finding 4, a review that took the source while it was linked
    // kept the linked record's data after Unlink.
    const later = await changeScientLibraryReview({
      projectRoot: project,
      library,
      change: { action: "create-review", title: "A later review" },
      actor: "user",
    });
    await changeScientLibraryReview({
      projectRoot: project,
      library,
      change: { action: "add-sources", reviewId: later.reviewId!, sourceIds: [screened.sourceId] },
      actor: "user",
    });

    // regression: review H1-e-1 finding 2, an unrelated review's damaged snapshot stopped Unlink.
    const unrelated = await changeScientLibraryReview({
      projectRoot: project,
      library,
      change: { action: "create-review", title: "An unrelated review" },
      actor: "user",
    });
    const damaged = NodePath.join(
      project,
      ".scient",
      "library",
      "reviews",
      `${unrelated.reviewId}.works.json`,
    );
    await NodeFSP.rm(damaged, { force: true });
    await NodeFSP.mkdir(damaged);

    await unlinkScientProjectSourceRestoringCopies({ ...repair, actor: "agent" });
    expect(await entry()).toMatchObject({
      title: "Screened only",
      abstract: "Abstract of Screened only.",
    });
    expect(
      (await readScientReviewSnapshotEntries(project, later.reviewId!)).get(screened.sourceId),
    ).toMatchObject({ title: "Screened only" });
  });
});
