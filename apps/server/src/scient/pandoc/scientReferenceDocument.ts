// @effect-diagnostics nodeBuiltinImport:off -- The reference document is packed in memory with yazl's stream API.
/**
 * Supply only Scient styles/page setup and let Pandoc fill standard package parts. Copy the
 * reference into each scratch directory under a fixed name so sandboxed command-line reads stay
 * explicit.
 */
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as yazl from "yazl";
import { catalogueFont } from "@scientfactory/scient-markdown";

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const BODY_FONT = `<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Calibri" w:cs="Arial"/>`;
const CODE_FONT = `<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/>`;
const HYPERLINK_LOOK = `<w:color w:val="0563C1"/><w:u w:val="single"/>`;
const HEADING_COLOR = "1F3864";

interface StyleSpec {
  readonly type: "paragraph" | "character" | "table";
  readonly id: string;
  readonly name: string;
  readonly basedOn?: string;
  readonly next?: string;
  readonly custom?: boolean;
  readonly isDefault?: boolean;
  readonly pPr?: string;
  readonly rPr?: string;
  /** Table properties and conditional formatting, for table styles. */
  readonly extra?: string;
}

function style(spec: StyleSpec): string {
  return [
    `<w:style w:type="${spec.type}"`,
    spec.isDefault === true ? ` w:default="1"` : "",
    spec.custom === true ? ` w:customStyle="1"` : "",
    ` w:styleId="${spec.id}">`,
    `<w:name w:val="${spec.name}"/>`,
    spec.basedOn === undefined ? "" : `<w:basedOn w:val="${spec.basedOn}"/>`,
    spec.next === undefined ? "" : `<w:next w:val="${spec.next}"/>`,
    `<w:qFormat/>`,
    spec.pPr === undefined ? "" : `<w:pPr>${spec.pPr}</w:pPr>`,
    spec.rPr === undefined ? "" : `<w:rPr>${spec.rPr}</w:rPr>`,
    spec.extra ?? "",
    `</w:style>`,
  ].join("");
}

// Word sizes are whole half points.
const size = (points: number) => {
  const halfPoints = Math.round(points * 2);
  return `<w:sz w:val="${halfPoints}"/><w:szCs w:val="${halfPoints}"/>`;
};

/** Heading sizes in points, level 1 first. */
const HEADING_POINTS = [18, 15, 13, 12, 11, 11, 11, 11, 11] as const;
/** Footnote text size in points. */
const FOOTNOTE_POINTS = 9;

function headingStyles(): Array<StyleSpec> {
  return HEADING_POINTS.map((points, index) => ({
    type: "paragraph",
    id: `Heading${index + 1}`,
    name: `heading ${index + 1}`,
    basedOn: "Normal",
    next: "BodyText",
    pPr: `<w:keepNext/><w:keepLines/><w:spacing w:before="${index < 2 ? 360 : 240}" w:after="80"/><w:outlineLvl w:val="${index}"/>`,
    rPr: `<w:b/><w:bCs/>${index >= 3 ? "<w:i/><w:iCs/>" : ""}<w:color w:val="${HEADING_COLOR}"/>${size(points)}`,
  }));
}

const TABLE_BORDER = (edge: string) =>
  `<w:${edge} w:val="single" w:sz="4" w:space="0" w:color="D0D7DE"/>`;

export const SCIENT_REFERENCE_STYLES: ReadonlyArray<StyleSpec> = [
  {
    type: "paragraph",
    id: "Normal",
    name: "Normal",
    isDefault: true,
    pPr: `<w:spacing w:after="0" w:line="276" w:lineRule="auto"/>`,
  },
  {
    type: "paragraph",
    id: "BodyText",
    name: "Body Text",
    basedOn: "Normal",
    pPr: `<w:spacing w:before="0" w:after="140"/>`,
  },
  {
    type: "paragraph",
    id: "ScientBeforeTable",
    name: "Scient Before Table",
    basedOn: "BodyText",
    custom: true,
    pPr: `<w:spacing w:before="0" w:after="180"/>`,
  },
  {
    type: "paragraph",
    id: "ScientAfterTable",
    name: "Scient After Table",
    basedOn: "BodyText",
    custom: true,
    pPr: `<w:spacing w:before="180" w:after="140"/>`,
  },
  {
    type: "paragraph",
    id: "ScientBetweenTables",
    name: "Scient Between Tables",
    basedOn: "BodyText",
    custom: true,
    pPr: `<w:spacing w:before="180" w:after="180"/>`,
  },
  {
    type: "paragraph",
    id: "FirstParagraph",
    name: "First Paragraph",
    basedOn: "BodyText",
    next: "BodyText",
  },
  {
    type: "paragraph",
    id: "Compact",
    name: "Compact",
    basedOn: "BodyText",
    pPr: `<w:spacing w:before="20" w:after="20"/>`,
  },
  {
    type: "paragraph",
    id: "Title",
    name: "Title",
    basedOn: "Normal",
    next: "BodyText",
    pPr: `<w:keepNext/><w:spacing w:before="240" w:after="120"/>`,
    rPr: `<w:b/><w:bCs/><w:color w:val="${HEADING_COLOR}"/>${size(24)}`,
  },
  {
    type: "paragraph",
    id: "Subtitle",
    name: "Subtitle",
    basedOn: "Title",
    next: "BodyText",
    rPr: `<w:b w:val="0"/><w:bCs w:val="0"/>${size(15)}`,
  },
  {
    type: "paragraph",
    id: "Author",
    name: "Author",
    basedOn: "Normal",
    next: "BodyText",
    pPr: `<w:spacing w:after="40"/>`,
  },
  {
    type: "paragraph",
    id: "Date",
    name: "Date",
    basedOn: "Normal",
    next: "BodyText",
    pPr: `<w:spacing w:after="200"/>`,
  },
  {
    type: "paragraph",
    id: "AbstractTitle",
    name: "Abstract Title",
    basedOn: "Normal",
    next: "Abstract",
    rPr: `<w:b/><w:bCs/>`,
  },
  {
    type: "paragraph",
    id: "Abstract",
    name: "Abstract",
    basedOn: "Normal",
    next: "BodyText",
    pPr: `<w:spacing w:before="100" w:after="300"/><w:ind w:left="567" w:right="567"/>`,
    rPr: size(10),
  },
  {
    type: "paragraph",
    id: "Bibliography",
    name: "Bibliography",
    basedOn: "Normal",
    pPr: `<w:spacing w:after="100"/><w:ind w:left="360" w:hanging="360"/>`,
  },
  ...headingStyles(),
  {
    type: "paragraph",
    id: "BlockText",
    name: "Block Text",
    basedOn: "BodyText",
    next: "BodyText",
    pPr: `<w:pBdr><w:left w:val="single" w:sz="18" w:space="8" w:color="BFBFBF"/></w:pBdr><w:ind w:left="340" w:right="340"/>`,
    rPr: `<w:color w:val="404040"/>`,
  },
  {
    type: "paragraph",
    id: "FootnoteText",
    name: "footnote text",
    basedOn: "Normal",
    pPr: `<w:spacing w:after="40"/>`,
    rPr: size(FOOTNOTE_POINTS),
  },
  {
    type: "paragraph",
    id: "DefinitionTerm",
    name: "Definition Term",
    basedOn: "Normal",
    next: "Definition",
    pPr: `<w:keepNext/><w:spacing w:before="80" w:after="0"/>`,
    rPr: `<w:b/><w:bCs/>`,
  },
  {
    type: "paragraph",
    id: "Definition",
    name: "Definition",
    basedOn: "Normal",
    pPr: `<w:spacing w:after="120"/><w:ind w:left="360"/>`,
  },
  {
    type: "paragraph",
    id: "Caption",
    name: "caption",
    basedOn: "Normal",
    pPr: `<w:spacing w:before="60" w:after="200"/>`,
    rPr: `<w:i/><w:iCs/>${size(9)}`,
  },
  {
    type: "paragraph",
    id: "TableCaption",
    name: "Table Caption",
    basedOn: "Caption",
    pPr: `<w:keepNext/>`,
  },
  { type: "paragraph", id: "ImageCaption", name: "Image Caption", basedOn: "Caption" },
  {
    type: "paragraph",
    id: "Figure",
    name: "Figure",
    basedOn: "Normal",
    pPr: `<w:spacing w:before="120" w:after="120"/>`,
  },
  {
    type: "paragraph",
    id: "CaptionedFigure",
    name: "Captioned Figure",
    basedOn: "Figure",
    pPr: `<w:keepNext/>`,
  },
  {
    type: "paragraph",
    id: "TOCHeading",
    name: "TOC Heading",
    basedOn: "Heading1",
    next: "BodyText",
    pPr: `<w:outlineLvl w:val="9"/>`,
  },
  {
    type: "paragraph",
    id: "SourceCode",
    name: "Source Code",
    basedOn: "Normal",
    custom: true,
    pPr: `<w:shd w:val="clear" w:color="auto" w:fill="F6F8FA"/><w:wordWrap w:val="off"/><w:spacing w:before="60" w:after="60" w:line="240" w:lineRule="auto"/>`,
    rPr: `${CODE_FONT}${size(9)}`,
  },
  {
    type: "character",
    id: "VerbatimChar",
    name: "Verbatim Char",
    custom: true,
    rPr: `${CODE_FONT}${size(9)}`,
  },
  {
    type: "character",
    id: "FootnoteReference",
    name: "footnote reference",
    rPr: `<w:vertAlign w:val="superscript"/>`,
  },
  {
    type: "character",
    id: "Hyperlink",
    name: "Hyperlink",
    rPr: HYPERLINK_LOOK,
  },
  {
    type: "table",
    id: "Table",
    name: "Table",
    custom: true,
    pPr: `<w:spacing w:before="20" w:after="20" w:line="240" w:lineRule="auto"/>`,
    extra: [
      `<w:tblPr><w:tblInd w:w="0" w:type="dxa"/>`,
      `<w:tblBorders>${["top", "bottom", "left", "right", "insideH", "insideV"].map(TABLE_BORDER).join("")}</w:tblBorders>`,
      `<w:tblCellMar><w:top w:w="54" w:type="dxa"/><w:left w:w="90" w:type="dxa"/><w:bottom w:w="54" w:type="dxa"/><w:right w:w="90" w:type="dxa"/></w:tblCellMar></w:tblPr>`,
      `<w:tblStylePr w:type="firstRow"><w:pPr><w:keepNext/></w:pPr><w:rPr><w:b/><w:bCs/></w:rPr>`,
      `<w:tcPr><w:shd w:val="clear" w:color="auto" w:fill="F6F8FA"/></w:tcPr></w:tblStylePr>`,
    ].join(""),
  },
  {
    type: "character",
    id: "ScientSpeakerUser",
    name: "Scient Speaker User",
    custom: true,
    rPr: `<w:color w:val="1F6FEB"/>`,
  },
  {
    type: "character",
    id: "ScientSpeakerAssistant",
    name: "Scient Speaker Assistant",
    custom: true,
    rPr: `<w:color w:val="7A3EC8"/>`,
  },
  {
    type: "paragraph",
    id: "ScientWorkLog",
    name: "Scient Work Log",
    basedOn: "BodyText",
    custom: true,
    pPr: `<w:spacing w:before="20" w:after="40"/><w:ind w:left="360"/>`,
    rPr: `<w:color w:val="595959"/>${size(9)}`,
  },
  {
    type: "paragraph",
    id: "ScientReasoning",
    name: "Scient Reasoning",
    basedOn: "BodyText",
    custom: true,
    pPr: `<w:spacing w:before="20" w:after="40"/><w:ind w:left="360"/>`,
    rPr: `<w:i/><w:iCs/><w:color w:val="7F7F7F"/>${size(9)}`,
  },
  {
    type: "paragraph",
    id: "ScientAlert",
    name: "Scient Alert",
    basedOn: "BodyText",
    custom: true,
    pPr: `<w:pBdr><w:left w:val="single" w:sz="24" w:space="8" w:color="2F6FDB"/></w:pBdr><w:shd w:val="clear" w:color="auto" w:fill="EEF4FB"/><w:spacing w:before="0" w:after="60"/><w:ind w:left="284" w:right="113"/>`,
  },
  {
    type: "paragraph",
    id: "ScientTaskList",
    name: "Scient Task List",
    basedOn: "BodyText",
    custom: true,
    pPr: `<w:spacing w:before="0" w:after="40"/><w:ind w:left="360" w:hanging="360"/>`,
  },
  {
    type: "character",
    id: "ScientPlaceholder",
    name: "Scient Placeholder",
    custom: true,
    rPr: `<w:i/><w:iCs/><w:color w:val="C00000"/>`,
  },
];

/** The document's base text size and font name (null for the default font), from its settings. */
export interface WordBaseFont {
  readonly sizePoints: number;
  readonly family: string | null;
}

export const DEFAULT_WORD_BASE_FONT: WordBaseFont = { sizePoints: 11, family: null };

/** A local size in points and/or a font name; a Word run carries only one style. */
export interface WordLocalFont {
  readonly size?: number | undefined;
  readonly family?: string | undefined;
  /** Inside a link: the run keeps the link's look, since a run carries only one style. */
  readonly link?: boolean | undefined;
}

const escapeXml = (text: string): string =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

/** Word font attributes; the complex-script font (Hebrew) is the same font only when it has Hebrew. */
const familyFonts = (family: string | null): string => {
  if (family === null) return BODY_FONT;
  const name = escapeXml(family);
  const complex = catalogueFont(family)?.hebrew === true ? name : "Arial";
  return `<w:rFonts w:ascii="${name}" w:hAnsi="${name}" w:eastAsia="${name}" w:cs="${complex}"/>`;
};

/** Word style name for a local font: "12 pt", "Times New Roman" or "Times New Roman 12 pt". */
export const wordFontStyleName = (font: WordLocalFont): string =>
  [font.family, font.size === undefined ? null : `${font.size} pt`, font.link ? "link" : null]
    .filter((part) => part !== undefined && part !== null)
    .join(" ");

function fontStyle(font: WordLocalFont): StyleSpec {
  const name = wordFontStyleName(font);
  return {
    type: "character",
    id: `Scient${name.replaceAll(".", "_").replaceAll(/[^A-Za-z0-9_]/gu, "")}`,
    name,
    custom: true,
    rPr: [
      font.family === undefined ? "" : familyFonts(font.family),
      font.size === undefined ? "" : size(font.size),
      font.link ? HYPERLINK_LOOK : "",
    ].join(""),
  };
}

function scientReferenceStylesXml(base: WordBaseFont, used: ReadonlyArray<WordLocalFont>): string {
  return [
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`,
    `<w:styles xmlns:w="${W}">`,
    `<w:docDefaults><w:rPrDefault><w:rPr>${familyFonts(base.family)}${size(base.sizePoints)}<w:lang w:val="en-US" w:eastAsia="en-US" w:bidi="he-IL"/></w:rPr></w:rPrDefault>`,
    `<w:pPrDefault><w:pPr><w:spacing w:after="0" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>`,
    ...[...SCIENT_REFERENCE_STYLES, ...used.map(fontStyle)].map(style),
    `</w:styles>`,
  ].join("");
}

/** A4 with 2.5 cm margins, in twentieths of a point. */
const SCIENT_PAGE = {
  width: 11_906,
  height: 16_838,
  margin: 1_418,
  header: 709,
  footer: 709,
} as const;

/** The portrait page's text area in points, for sizes given as a share of it. */
export const SCIENT_TEXT_AREA_POINTS = {
  width: (SCIENT_PAGE.width - 2 * SCIENT_PAGE.margin) / 20,
  height: (SCIENT_PAGE.height - 2 * SCIENT_PAGE.margin) / 20,
} as const;

/** A section's page setup; Pandoc takes the document's last section from the reference. */
export function sectionPropertiesXml(input: {
  readonly landscape: boolean;
  readonly rtl: boolean;
}): string {
  const { width, height, margin, header, footer } = SCIENT_PAGE;
  const size = input.landscape
    ? `<w:pgSz w:w="${height}" w:h="${width}" w:orient="landscape"/>`
    : `<w:pgSz w:w="${width}" w:h="${height}"/>`;
  return [
    `<w:sectPr>`,
    size,
    `<w:pgMar w:top="${margin}" w:right="${margin}" w:bottom="${margin}" w:left="${margin}" w:header="${header}" w:footer="${footer}" w:gutter="0"/>`,
    input.rtl ? `<w:bidi/>` : "",
    `</w:sectPr>`,
  ].join("");
}

const DOCUMENT_XML = [
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`,
  `<w:document xmlns:w="${W}"><w:body><w:p/>`,
  sectionPropertiesXml({ landscape: false, rtl: false }),
  `</w:body></w:document>`,
].join("");

const CONTENT_TYPES = [
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`,
  `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`,
  `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>`,
  `<Default Extension="xml" ContentType="application/xml"/>`,
  `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>`,
  `<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>`,
  `</Types>`,
].join("");

const PACKAGE_RELATIONSHIPS = [
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`,
  `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`,
  `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>`,
  `</Relationships>`,
].join("");

const DOCUMENT_RELATIONSHIPS = [
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`,
  `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`,
  `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`,
  `</Relationships>`,
].join("");

/** Fixed entry time, so the reference document is byte-for-byte reproducible. */
const ENTRY_TIME = DateTime.toDateUtc(DateTime.makeUnsafe("2026-01-01T00:00:00Z"));

export function scientReferenceDocumentParts(
  base: WordBaseFont = DEFAULT_WORD_BASE_FONT,
  used: ReadonlyArray<WordLocalFont> = [],
): ReadonlyArray<readonly [string, string]> {
  return [
    ["[Content_Types].xml", CONTENT_TYPES],
    ["_rels/.rels", PACKAGE_RELATIONSHIPS],
    ["word/document.xml", DOCUMENT_XML],
    ["word/_rels/document.xml.rels", DOCUMENT_RELATIONSHIPS],
    ["word/styles.xml", scientReferenceStylesXml(base, used)],
  ];
}

// Reuse common combinations without retaining every document’s style set for the server lifetime.
const cached = new Map<string, Promise<Uint8Array>>();

function packReferenceDocument(
  base: WordBaseFont,
  used: ReadonlyArray<WordLocalFont>,
): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    const chunks: Array<Buffer> = [];
    zip.outputStream.on("data", (chunk: Buffer) => chunks.push(chunk));
    zip.outputStream.on("error", reject);
    zip.outputStream.on("end", () => resolve(new Uint8Array(Buffer.concat(chunks))));
    for (const [name, contents] of scientReferenceDocumentParts(base, used)) {
      zip.addBuffer(Buffer.from(contents, "utf8"), name, { mtime: ENTRY_TIME, mode: 0o100644 });
    }
    zip.end();
  });
}

/** The packed reference document for a base font and the local fonts used; recent combinations are reused. */
export const scientReferenceDocumentFor = (
  base: WordBaseFont,
  used: ReadonlyArray<WordLocalFont> = [],
) =>
  Effect.promise(() => {
    const key = [
      `${base.sizePoints}/${base.family ?? ""}`,
      ...used.map(wordFontStyleName).toSorted(),
    ].join("|");
    const existing = cached.get(key);
    if (existing !== undefined) return existing;
    const packed = packReferenceDocument(base, used);
    const oldest = cached.keys().next();
    if (cached.size >= 16 && !oldest.done) cached.delete(oldest.value);
    cached.set(key, packed);
    void packed.catch(() => {
      if (cached.get(key) === packed) cached.delete(key);
    });
    return packed;
  });

export const scientReferenceDocument = scientReferenceDocumentFor(DEFAULT_WORD_BASE_FONT);
