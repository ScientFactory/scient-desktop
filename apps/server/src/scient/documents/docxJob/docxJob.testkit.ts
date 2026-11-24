// @effect-diagnostics nodeBuiltinImport:off -- Tests read the committed Word fixture from disk.
import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";

import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { readDocxPackage, writeDocxPackage, type DocxEntry } from "./docxPackage.ts";
import { MAIN_PART, encodePart, partText } from "./docxTrackedReplacement.ts";

const FIXED_TIME = DateTime.toDateUtc(DateTime.makeUnsafe("2026-11-24T00:00:00Z"));

/**
 * A trusted synthetic bilingual manuscript made with python-docx: RTL Hebrew paragraphs with
 * niqqud, an LTR dated ID and a signed range inside one Hebrew sentence, a comment anchor, an
 * earlier tracked insertion, a native equation, a header and page-number footer, and a
 * right-to-left table whose heading row repeats across three A4 pages.
 */
const BILINGUAL_FIXTURE = NodeURL.fileURLToPath(
  new URL("./fixtures/bilingual-manuscript.docx", import.meta.url),
);

export const DATED_ID = { find: "QC-ID-007 (2026-11-24)", replace: "QC-ID-008 (2026-11-25)" };
export const SIGNED_RANGE = "−3.2–4.5";
export const HEBREW_WORD = { find: "נבדקו", replace: "נבחנו" };
export const REVIEW = { author: "QA Reviewer", date: "2026-11-24T09:00:00Z" } as const;

export const fixtureBytes = (): Uint8Array =>
  new Uint8Array(NodeFS.readFileSync(BILINGUAL_FIXTURE));

export const fixtureEntries = () => readDocxPackage(fixtureBytes());

/** The package with its main part rewritten by `change`, every other part as it was. */
export const withMainPart = (
  entries: ReadonlyArray<DocxEntry>,
  change: (xml: string) => string,
): ReadonlyArray<DocxEntry> =>
  entries.map((entry) =>
    entry.name === MAIN_PART
      ? { ...entry, bytes: encodePart(change(partText(entries, MAIN_PART)!)) }
      : entry,
  );

export const withPart = (
  entries: ReadonlyArray<DocxEntry>,
  name: string,
  text: string,
): ReadonlyArray<DocxEntry> => {
  const replaced = entries.some((entry) => entry.name === name)
    ? entries.map((entry) => (entry.name === name ? { ...entry, bytes: encodePart(text) } : entry))
    : [...entries, { name, bytes: encodePart(text), compressed: true, modified: FIXED_TIME }];
  return replaced;
};

/** The fixture with the dated ID's run hidden, so no render can show the edit. */
export const hiddenIdFixture = Effect.gen(function* () {
  const entries = yield* fixtureEntries();
  return yield* writeDocxPackage(
    withMainPart(entries, (xml) =>
      xml.replace(
        `<w:rPr><w:rtl w:val="0"/><w:lang w:val="en-US"/></w:rPr><w:t>${DATED_ID.find}</w:t>`,
        `<w:rPr><w:vanish/><w:rtl w:val="0"/><w:lang w:val="en-US"/></w:rPr><w:t>${DATED_ID.find}</w:t>`,
      ),
    ),
  );
});

export const TINY_EDIT = { find: "REF-1", replace: "REF-2" };
export const TINY_SOURCE_PDF = NodeURL.fileURLToPath(
  new URL("./fixtures/tiny-source.pdf", import.meta.url),
);
export const TINY_CANDIDATE_PDF = NodeURL.fileURLToPath(
  new URL("./fixtures/tiny-candidate.pdf", import.meta.url),
);

const W_MAIN = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

/** A one-paragraph ASCII Word file; `tiny-*.pdf` are LibreOffice renders of it and its edit. */
export const tinyDocx = writeDocxPackage(
  [
    [
      "[Content_Types].xml",
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    ],
    [
      "_rels/.rels",
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    ],
    [
      "word/document.xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="${W_MAIN}"><w:body><w:p><w:r><w:t xml:space="preserve">Alpha </w:t></w:r><w:r><w:t>REF-1</w:t></w:r><w:r><w:t xml:space="preserve"> omega.</w:t></w:r></w:p><w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>`,
    ],
  ].map(([name, text]) => ({
    name: name!,
    bytes: encodePart(text!),
    compressed: true,
    modified: FIXED_TIME,
  })),
);
