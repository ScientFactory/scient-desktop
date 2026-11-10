// @effect-diagnostics nodeBuiltinImport:off -- Review tests exercise the real project filesystem boundary.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { initializeScientProject } from "@scientfactory/project-init";
import { afterEach, describe, expect, it } from "@effect/vitest";

import { createScientSourceCollection } from "./collections.ts";
import type { ScientSourceCandidate } from "./model.ts";
import { importScientSource, readScientSourceRecord, removeScientSource } from "./store.ts";
import { scientPrismaMermaid, scientReviewPendingIds } from "./systematicReview.ts";
import {
  changeScientSystematicReview,
  listScientSystematicReviews,
  readScientSystematicReview,
} from "./systematicReviewStore.ts";

const fixtures: string[] = [];

afterEach(async () => {
  await Promise.all(
    fixtures.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});

function candidate(index: number, title: string, year: number): ScientSourceCandidate {
  return {
    sourceKey: `S${index}`,
    type: "article",
    customType: null,
    title,
    creators: [
      { creatorType: "author", givenName: "Ada", familyName: `Author${index}`, literalName: null },
    ],
    issuedRaw: String(year),
    issuedYear: year,
    identifiers: [{ scheme: "doi", value: `10.1000/review-${index}` }],
    abstract: null,
    containerTitle: null,
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
  };
}

async function project(titles: ReadonlyArray<readonly [string, number]>) {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-review-"));
  fixtures.push(root);
  await initializeScientProject({ root });
  const sourceIds: string[] = [];
  for (const [index, [title, year]] of titles.entries()) {
    const imported = await importScientSource({
      root,
      operationId: NodeCrypto.randomUUID(),
      candidate: candidate(index, title, year),
      allowPossibleMetadataMatch: true,
    });
    if (!imported.record) throw new Error("Expected an imported source.");
    sourceIds.push(imported.record.sourceId);
  }
  return { root, sourceIds };
}

describe("Systematic reviews", () => {
  it("logs searches, removes duplicates and screens two stages into a PRISMA flow", async () => {
    const { root, sourceIds } = await project([
      ["Early goal-directed therapy in sepsis", 2014],
      ["Early goal directed therapy in sepsis", 2013],
      ["Vasopressin versus norepinephrine", 2008],
      ["Fluid balance and mortality", 2011],
      ["Unrelated cardiology trial", 2019],
    ]);
    const [egdt, egdtPreprint, vasopressin, fluids, unrelated] = sourceIds as [
      string,
      string,
      string,
      string,
      string,
    ];
    const created = await changeScientSystematicReview({
      root,
      change: {
        action: "create-review",
        title: "Sepsis resuscitation",
        question: "Does EGDT help?",
      },
      actor: "user",
    });
    const reviewId = created.reviewId ?? "";
    const pubmed = await changeScientSystematicReview({
      root,
      change: {
        action: "log-search",
        reviewId,
        database: "PubMed",
        query: "sepsis AND resuscitation",
        searchedOn: "2026-11-10",
        resultCount: 5,
        sourceIds: [egdt, egdtPreprint, vasopressin, "source_missing"],
      },
      actor: "agent",
    });
    expect(pubmed).toMatchObject({ outcome: "updated", skippedSourceIds: ["source_missing"] });
    await changeScientSystematicReview({
      root,
      change: {
        action: "log-search",
        reviewId,
        database: "Embase",
        query: "'sepsis'/exp",
        searchedOn: "2026-11-10",
        sourceIds: [egdt, fluids],
      },
      actor: "user",
    });
    await changeScientSystematicReview({
      root,
      change: { action: "add-sources", reviewId, sourceIds: [unrelated] },
      actor: "user",
    });

    const before = await readScientSystematicReview(root, reviewId);
    expect(before?.possibleDuplicates).toEqual([[egdt, egdtPreprint]]);
    await changeScientSystematicReview({
      root,
      change: { action: "mark-duplicate", reviewId, sourceId: egdtPreprint, duplicateOf: egdt },
      actor: "user",
    });

    const titleAbstract = await changeScientSystematicReview({
      root,
      change: {
        action: "screen",
        reviewId,
        stage: "title-abstract",
        decisions: [
          { sourceId: egdt, decision: "include" },
          { sourceId: vasopressin, decision: "include" },
          { sourceId: fluids, decision: "maybe" },
          { sourceId: unrelated, decision: "exclude", reason: "Wrong population" },
          { sourceId: egdtPreprint, decision: "include" },
        ],
      },
      actor: "agent",
    });
    expect(titleAbstract.skippedSourceIds).toEqual([egdtPreprint]);
    const fullText = await changeScientSystematicReview({
      root,
      change: {
        action: "screen",
        reviewId,
        stage: "full-text",
        decisions: [
          { sourceId: egdt, decision: "include" },
          { sourceId: vasopressin, decision: "exclude", reason: "Wrong intervention" },
          { sourceId: fluids, decision: "include" },
        ],
      },
      actor: "user",
    });
    expect(fullText.skippedSourceIds).toEqual([fluids]);

    const detail = await readScientSystematicReview(root, reviewId);
    expect(detail?.possibleDuplicates).toEqual([]);
    expect(detail?.prisma).toEqual({
      identified: {
        databases: 7,
        byDatabase: [
          { database: "PubMed", count: 5 },
          { database: "Embase", count: 2 },
        ],
        otherMethods: 1,
      },
      // egdt appears in both searches, and the preprint was marked as its duplicate.
      removedBeforeScreening: { duplicates: 2, other: 2 },
      screened: 4,
      titleAbstract: { included: 2, excluded: 1, maybe: 1, pending: 0 },
      fullText: {
        assessed: 2,
        excluded: 1,
        excludedByReason: [{ reason: "Wrong intervention", count: 1 }],
        maybe: 0,
        pending: 0,
      },
      included: 1,
    });
    expect(scientPrismaMermaid(detail!.prisma)).toContain(
      'included["Studies included in review (n = 1)"]',
    );
    const listed = await listScientSystematicReviews(root);
    expect(listed.reviews.map((review) => [review.title, review.searchCount])).toEqual([
      ["Sepsis resuscitation", 2],
    ]);
  });

  it("keeps the latest decision, skips repeats, and reopens a record when it is cleared", async () => {
    const { root, sourceIds } = await project([["A long enough title for screening", 2020]]);
    const [only] = sourceIds as [string];
    const { reviewId } = await changeScientSystematicReview({
      root,
      change: { action: "create-review", title: "Review" },
      actor: "user",
    });
    const id = reviewId ?? "";
    await changeScientSystematicReview({
      root,
      change: { action: "add-sources", reviewId: id, sourceIds: [only] },
      actor: "user",
    });
    const screen = (decision: "include" | "exclude") =>
      changeScientSystematicReview({
        root,
        change: {
          action: "screen",
          reviewId: id,
          stage: "title-abstract",
          decisions: [{ sourceId: only, decision }],
        },
        actor: "user",
      });
    expect((await screen("exclude")).outcome).toBe("updated");
    expect((await screen("exclude")).outcome).toBe("unchanged");
    expect((await screen("include")).outcome).toBe("updated");
    const detail = await readScientSystematicReview(root, id);
    expect(detail?.prisma.titleAbstract).toMatchObject({ included: 1, excluded: 0 });
    expect(detail?.review.screening).toHaveLength(2);

    await changeScientSystematicReview({
      root,
      change: { action: "clear-decision", reviewId: id, stage: "title-abstract", sourceId: only },
      actor: "user",
    });
    const cleared = await readScientSystematicReview(root, id);
    expect(scientReviewPendingIds(cleared!.review, "title-abstract", new Set([only]))).toEqual([
      only,
    ]);
    // Undoing keeps every earlier decision in the review's history.
    expect(
      cleared?.review.screening.map((entry) => [entry.decision, entry.cleared ?? false]),
    ).toEqual([
      ["exclude", false],
      ["include", false],
      ["include", true],
    ]);
  });

  it("logs a search from a collection and counts a trashed record as removed", async () => {
    const { root, sourceIds } = await project([
      ["First record with a long title", 2020],
      ["Second record with a long title", 2021],
    ]);
    const [first, second] = sourceIds as [string, string];
    const collection = await createScientSourceCollection({
      root,
      name: "PubMed export",
      sourceIds,
      actor: "user",
    });
    const { reviewId } = await changeScientSystematicReview({
      root,
      change: { action: "create-review", title: "Review" },
      actor: "user",
    });
    await changeScientSystematicReview({
      root,
      change: {
        action: "log-search",
        reviewId: reviewId ?? "",
        database: "PubMed",
        query: "q",
        searchedOn: "2026-11-10",
        collectionId: collection.collection?.collectionId ?? "",
      },
      actor: "user",
    });
    const record = await readScientSourceRecord(root, second);
    await removeScientSource({ root, sourceId: second, expectedRevision: record?.revision ?? 1 });

    const detail = await readScientSystematicReview(root, reviewId ?? "");
    expect(detail?.review.searches[0]?.sourceIds).toEqual([first, second]);
    expect(detail?.prisma).toMatchObject({
      identified: { databases: 2 },
      removedBeforeScreening: { duplicates: 0, other: 1 },
      screened: 1,
    });
  });

  it("deletes and restores a review, and reports one unreadable review without failing", async () => {
    const { root } = await project([]);
    const { reviewId } = await changeScientSystematicReview({
      root,
      change: { action: "create-review", title: "Kept" },
      actor: "user",
    });
    const id = reviewId ?? "";
    await changeScientSystematicReview({
      root,
      change: { action: "delete-review", reviewId: id },
      actor: "agent",
    });
    expect((await listScientSystematicReviews(root)).reviews).toEqual([]);
    expect(await readScientSystematicReview(root, id)).toBeNull();
    await changeScientSystematicReview({
      root,
      change: { action: "restore-review", reviewId: id },
      actor: "user",
    });
    await NodeFSP.writeFile(
      NodePath.join(root, ".scient/sources/reviews/review_broken.json"),
      "{",
      "utf8",
    );

    const listed = await listScientSystematicReviews(root);
    expect(listed.reviews.map((review) => review.title)).toEqual(["Kept"]);
    expect(listed.issues).toEqual([
      ".scient/sources/reviews/review_broken.json could not be read.",
    ]);
  });
});
