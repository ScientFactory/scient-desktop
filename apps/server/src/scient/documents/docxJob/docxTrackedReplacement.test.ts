import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  DATED_ID,
  HEBREW_WORD,
  REVIEW,
  SIGNED_RANGE,
  fixtureEntries,
  withMainPart,
  withPart,
} from "./docxJob.testkit.ts";
import { readDocxPackage, writeDocxPackage, type DocxEntry } from "./docxPackage.ts";
import {
  MAIN_PART,
  applyTrackedReplacement,
  docxInventory,
  partText,
  refuseUnsupportedInput,
  verifyTrackedReplacement,
} from "./docxTrackedReplacement.ts";

const request = { ...DATED_ID, ...REVIEW };

const edited = Effect.fn("test.edited")(function* (
  entries: ReadonlyArray<DocxEntry>,
  edit: { readonly find: string; readonly replace: string } = DATED_ID,
) {
  const result = applyTrackedReplacement(partText(entries, MAIN_PART)!, { ...edit, ...REVIEW });
  if (result._tag !== "edited") throw new Error(`edit refused: ${result.reason}`);
  const bytes = yield* writeDocxPackage(withMainPart(entries, () => result.xml));
  return { result, candidate: yield* readDocxPackage(bytes) };
});

const failed = (verification: ReturnType<typeof verifyTrackedReplacement>) =>
  verification.checks.filter((check) => !check.passed).map((check) => check.id);

describe("tracked replacement in an existing bilingual Word file", () => {
  it.effect("replaces the dated ID in mixed RTL text and proves acceptance and rejection", () =>
    Effect.gen(function* () {
      const entries = yield* fixtureEntries();
      expect(refuseUnsupportedInput(entries)).toBeNull();
      const { result, candidate } = yield* edited(entries);
      // The new ID ends in ")" inside a Hebrew paragraph.
      expect(result.neutralAtRightToLeftEdge).toBe(true);
      const xml = partText(candidate, MAIN_PART)!;
      expect(xml).toContain(
        `<w:del w:id="${result.deletionId}" w:author="QA Reviewer" w:date="2026-11-24T09:00:00Z"><w:r><w:rPr><w:rtl w:val="0"/><w:lang w:val="en-US"/></w:rPr><w:delText xml:space="preserve">${DATED_ID.find}</w:delText></w:r></w:del>`,
      );
      expect(xml).toContain(`<w:t>${SIGNED_RANGE}</w:t>`);
      const verification = verifyTrackedReplacement(entries, candidate, request);
      expect(failed(verification)).toEqual([]);
      expect(verification.passed).toBe(true);
      expect(verification.candidate).toEqual({
        ...verification.source,
        insertions: verification.source!.insertions + 1,
        deletions: 1,
      });
      expect(verification.source).toMatchObject({
        commentAnchors: 3,
        equations: 1,
        rightToLeftTables: 1,
        repeatedHeaderRows: 1,
        insertions: 1,
      });
    }),
  );

  it.effect("replaces a Hebrew word and counts the new letters", () =>
    Effect.gen(function* () {
      const entries = yield* fixtureEntries();
      const { result, candidate } = yield* edited(entries, HEBREW_WORD);
      expect(result.neutralAtRightToLeftEdge).toBe(false);
      const verification = verifyTrackedReplacement(entries, candidate, {
        ...HEBREW_WORD,
        ...REVIEW,
      });
      expect(failed(verification)).toEqual([]);
      expect(verification.candidate!.hebrewLetters).toBe(verification.source!.hebrewLetters + 5);
    }),
  );

  it.effect("refuses edits it cannot make exactly", () =>
    Effect.gen(function* () {
      const xml = partText(yield* fixtureEntries(), MAIN_PART)!;
      const refusal = (find: string) =>
        applyTrackedReplacement(xml, { find, replace: "x", ...REVIEW });
      expect(refusal("12.5%")).toEqual({
        _tag: "refused",
        reason: "text-ambiguous",
        occurrences: 4,
      });
      expect(refusal("absent text")).toMatchObject({ reason: "text-not-found" });
      // The ID and the following Hebrew are separate runs.
      expect(refusal("(2026-11-24) ואת")).toMatchObject({ reason: "text-spans-runs" });
      // Inside the earlier reviewer's tracked insertion.
      expect(refusal("בגיליון נפרד")).toMatchObject({ reason: "unsupported-run" });
    }),
  );

  it.effect("refuses inputs that would make the renderer read outside the package", () =>
    Effect.gen(function* () {
      const entries = yield* fixtureEntries();
      const rels = partText(entries, "word/_rels/document.xml.rels")!;
      expect(
        refuseUnsupportedInput(
          withPart(
            entries,
            "word/_rels/document.xml.rels",
            rels.replace(
              "</Relationships>",
              '<Relationship Id="rIdX" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="file:///etc/hosts" TargetMode="External"/></Relationships>',
            ),
          ),
        ),
      ).toBe("external-resources");
      expect(
        refuseUnsupportedInput(
          withMainPart(entries, (xml) =>
            xml.replace(
              "<w:body>",
              '<w:body><w:p><w:r><w:instrText xml:space="preserve"> INCLUDEPICTURE "http://example.test/a.png" </w:instrText></w:r></w:p>',
            ),
          ),
        ),
      ).toBe("external-fields");
      expect(
        refuseUnsupportedInput(
          withMainPart(entries, (xml) =>
            xml.replace("<w:body>", '<w:body><w:altChunk r:id="rId1"/>'),
          ),
        ),
      ).toBe("embedded-documents");
      expect(refuseUnsupportedInput(withPart(entries, "word/vbaProject.bin", "x"))).toBe(
        "macro-enabled",
      );
      expect(
        refuseUnsupportedInput(
          withMainPart(entries, (xml) => xml.replace("<w:body>", "<!DOCTYPE x><w:body>")),
        ),
      ).toBe("malformed-part");
    }),
  );

  it.effect("rejects candidates that change anything beyond the one tracked replacement", () =>
    Effect.gen(function* () {
      const entries = yield* fixtureEntries();
      const { candidate } = yield* edited(entries);
      const tamper = (change: (xml: string) => string) =>
        failed(verifyTrackedReplacement(entries, withMainPart(candidate, change), request));

      // A comment anchor elsewhere in the document is lost.
      expect(tamper((xml) => xml.replace('<w:commentRangeStart w:id="0"/>', ""))).toContain(
        "single-paragraph-changed",
      );
      // The signed range beside the edit is rewritten in the same paragraph.
      expect(tamper((xml) => xml.replace(SIGNED_RANGE, "3.2–−4.5"))).toEqual([
        "rejection-restores-source",
        "acceptance-applies-replacement",
      ]);
      // The inserted run loses its direction property.
      expect(
        tamper((xml) =>
          xml.replace(
            `<w:rPr><w:rtl w:val="0"/><w:lang w:val="en-US"/></w:rPr><w:t xml:space="preserve">${DATED_ID.replace}`,
            `<w:rPr><w:lang w:val="en-US"/></w:rPr><w:t xml:space="preserve">${DATED_ID.replace}`,
          ),
        ),
      ).toEqual(["acceptance-applies-replacement"]);
      // The revision is attributed to someone else.
      expect(tamper((xml) => xml.replaceAll('w:author="QA Reviewer"', 'w:author="Other"'))).toEqual(
        ["tracked-revision-marked"],
      );
      // Another part changes.
      expect(
        failed(
          verifyTrackedReplacement(
            entries,
            withPart(candidate, "word/comments.xml", "<w:comments/>"),
            request,
          ),
        ),
      ).toContain("package-parts-preserved");
      // The untouched source is not a tracked replacement.
      expect(failed(verifyTrackedReplacement(entries, entries, request))).toContain(
        "single-paragraph-changed",
      );
    }),
  );

  it("counts the features the job promises to keep", () => {
    expect(
      docxInventory(
        '<w:document xmlns:w="w"><w:body><w:p><w:pPr><w:bidi/></w:pPr><w:r><w:br w:type="page"/><w:t>שלום</w:t></w:r></w:p><w:sectPr><w:bidi/></w:sectPr></w:body></w:document>',
      ),
    ).toMatchObject({ rightToLeftParagraphs: 1, pageBreaks: 1, sections: 1, hebrewLetters: 4 });
  });

  it("keeps every byte outside the edited run", () => {
    const xml =
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r w:rsidR="1"><w:rPr><w:b/></w:rPr><w:t>a &amp; b</w:t></w:r></w:p><w:p><w:r><w:t>tail</w:t></w:r></w:p></w:body></w:document>';
    const result = applyTrackedReplacement(xml, { find: "&", replace: "<and>", ...REVIEW });
    expect(result).toMatchObject({ _tag: "edited", deletionId: "1", insertionId: "2" });
    if (result._tag !== "edited") return;
    expect(result.xml).toBe(
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p>' +
        '<w:r w:rsidR="1"><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">a </w:t></w:r>' +
        '<w:del w:id="1" w:author="QA Reviewer" w:date="2026-11-24T09:00:00Z"><w:r w:rsidR="1"><w:rPr><w:b/></w:rPr><w:delText xml:space="preserve">&amp;</w:delText></w:r></w:del>' +
        '<w:ins w:id="2" w:author="QA Reviewer" w:date="2026-11-24T09:00:00Z"><w:r w:rsidR="1"><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">&lt;and&gt;</w:t></w:r></w:ins>' +
        '<w:r w:rsidR="1"><w:rPr><w:b/></w:rPr><w:t xml:space="preserve"> b</w:t></w:r>' +
        "</w:p><w:p><w:r><w:t>tail</w:t></w:r></w:p></w:body></w:document>",
    );
  });
});
