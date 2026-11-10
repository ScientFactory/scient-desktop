// @effect-diagnostics nodeBuiltinImport:off -- Service tests write synthetic project PDFs.
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";
import type { ScientSourceCandidate } from "@scientfactory/scient-sources";
import { importScientSource } from "@scientfactory/scient-sources/store";
import * as Effect from "effect/Effect";

import {
  readerAnchor,
  temporaryProject,
  textPdf,
  writeProjectFile,
} from "./annotationTestUtils.ts";
import { layer, ScientAnnotations } from "./ScientAnnotations.ts";

const project = Effect.acquireDisposable(Effect.promise(temporaryProject));
const write = (root: string, relativePath: string, pages: ReadonlyArray<ReadonlyArray<string>>) =>
  Effect.promise(() => writeProjectFile(root, relativePath, textPdf(pages)));

const paperPages = [
  ["Sleep and memory", "We studied sleep in mice."],
  ["Results", "Deep sleep doubled recall."],
];

const candidate: ScientSourceCandidate = {
  sourceKey: "sleep-paper",
  type: "article",
  customType: null,
  title: "Sleep and memory",
  creators: [],
  issuedRaw: null,
  issuedYear: 2024,
  identifiers: [],
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
  pdfAvailable: true,
  pdfFileName: "sleep.pdf",
  pdfAttachmentCount: 1,
};

describe("ScientAnnotations", () => {
  it.effect("keeps a reader's highlight with the PDF's bytes, not its path", () =>
    Effect.gen(function* () {
      const { root } = yield* project;
      const annotations = yield* ScientAnnotations;
      yield* write(root, "papers/sleep.pdf", paperPages);
      const opened = yield* annotations.forDocument({ root, relativePath: "papers/sleep.pdf" });
      if (opened.status !== "available") throw new Error("Expected an annotatable PDF");
      expect(opened.annotations).toEqual([]);
      const command = {
        action: "create" as const,
        annotationId: "ann_reader0001",
        anchor: readerAnchor({ text: "We studied sleep in mice.", quote: "sleep in mice" }),
        highlighted: true,
        note: "",
      };
      const request = { root, relativePath: "papers/sleep.pdf", material: opened.material };
      expect((yield* annotations.mutate({ ...request, command }, "user")).outcome).toBe("created");

      yield* write(root, "papers/sleep.pdf", [["A different file"]]);
      const refused = yield* annotations.mutate(
        { ...request, command: { ...command, annotationId: "ann_reader0002" } },
        "user",
      );
      expect(refused.outcome).toBe("material-changed");

      yield* write(root, "copy/sleep.pdf", paperPages);
      const copy = yield* annotations.forDocument({ root, relativePath: "copy/sleep.pdf" });
      expect(copy.status === "available" && copy.annotations.map((a) => a.annotationId)).toEqual([
        "ann_reader0001",
      ]);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("reports a folder that is not a Scient project as unavailable", () =>
    Effect.gen(function* () {
      const { root } = yield* project;
      const annotations = yield* ScientAnnotations;
      const result = yield* annotations.forDocument({
        root: NodePath.join(root, ".scient"),
        relativePath: "x.pdf",
      });
      expect(result).toEqual({ status: "unavailable" });
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("lets an agent highlight a Source's PDF by quote, then remove and restore it", () =>
    Effect.gen(function* () {
      const { root } = yield* project;
      const annotations = yield* ScientAnnotations;
      yield* write(root, "inbox/sleep.pdf", paperPages);
      const imported = yield* Effect.promise(() =>
        importScientSource({
          root,
          operationId: "import-sleep",
          candidate,
          pdfPath: NodePath.join(root, "inbox", "sleep.pdf"),
        }),
      );
      const sourceId = imported.record!.sourceId;
      const annotate = (quote: string, note: string) =>
        annotations.annotateQuote({
          root,
          pdf: { sourceId },
          quote,
          note,
          highlighted: true,
          actor: "agent",
        });

      const added = yield* annotate("deep sleep doubled recall", "Main result");
      if (!("annotation" in added) || !added.annotation) throw new Error("Expected an annotation");
      expect(added.outcome).toBe("created");
      expect(added.annotation).toMatchObject({ createdBy: "agent", note: "Main result" });
      expect(added.annotation.anchor.selector.pages[0]).toMatchObject({
        page: 2,
        quote: "Deep sleep doubled recall",
      });
      expect(added.pdf.sources).toEqual([
        {
          sourceId,
          attachmentId: expect.any(String),
          title: "Sleep and memory",
          citationKey: "anon2024sleep",
        },
      ]);
      const annotationId = added.annotation.annotationId;

      // The same passage again, typed differently, is the same annotation.
      expect(yield* annotate("Deep  sleep doubled RECALL", "")).toMatchObject({
        outcome: "unchanged",
        annotation: { annotationId },
      });
      const onSource = yield* annotations.forSource({ root, sourceId });
      expect(onSource.attachments[0]!.annotations.map((a) => a.note)).toEqual(["Main result"]);

      const removed = yield* annotations.mutateById({
        root,
        command: { action: "remove", annotationId, expectedRevision: 1 },
        actor: "agent",
      });
      expect(removed.result.outcome).toBe("removed");
      const listed = yield* annotations.list({ root, includeRemoved: true, query: "main result" });
      expect(listed?.total).toBe(1);
      expect(listed?.pdfs[0]!.annotations[0]!.deletedAt).not.toBeNull();
      const restored = yield* annotations.mutateById({
        root,
        command: { action: "restore", annotationId, expectedRevision: 2 },
        actor: "user",
      });
      expect(restored.result).toMatchObject({ outcome: "restored", annotation: { revision: 3 } });
      expect(restored.history.map((entry) => entry.revision)).toEqual([1, 2]);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("tells an agent when a quote is missing or repeated", () =>
    Effect.gen(function* () {
      const { root } = yield* project;
      const annotations = yield* ScientAnnotations;
      yield* write(root, "notes.pdf", [["p < 0.05 for recall"], ["p < 0.05 for speed"]]);
      const annotate = (quote: string, page?: number) =>
        annotations.annotateQuote({
          root,
          pdf: { relativePath: "notes.pdf" },
          quote,
          ...(page === undefined ? {} : { page }),
          note: "",
          highlighted: true,
          actor: "agent",
        });
      expect(yield* annotate("p < 0.05")).toEqual({ outcome: "quote-ambiguous", pages: [1, 2] });
      expect((yield* annotate("p < 0.05", 2)).outcome).toBe("created");
      expect(yield* annotate("not in this paper")).toEqual({ outcome: "quote-not-found" });
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );
});
