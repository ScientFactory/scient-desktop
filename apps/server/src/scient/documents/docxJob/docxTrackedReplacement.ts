import { SaxesParser } from "saxes";

import type { DocxEntry } from "./docxPackage.ts";
import {
  OoxmlShapeError,
  escapeXmlAttribute,
  isOoxmlShapeError,
  escapeXmlText,
  matchingClose,
  tokenizeXml,
  type XmlToken,
} from "./ooxmlXml.ts";

export const MAIN_PART = "word/document.xml";
const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const WORD_MAIN_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml";
const MAX_REVISION_ID = 2_147_483_647;

export interface TrackedReplacementRequest {
  readonly find: string;
  readonly replace: string;
  readonly author: string;
  /** UTC, `YYYY-MM-DDTHH:MM:SSZ`. */
  readonly date: string;
}

export type DocxInputRefusal =
  | "not-a-word-document"
  | "macro-enabled"
  | "external-resources"
  | "external-fields"
  | "embedded-documents"
  | "malformed-part";

export type DocxEditRefusal =
  | "malformed-part"
  | "text-not-found"
  | "text-ambiguous"
  | "text-spans-runs"
  | "unsupported-run"
  | "revision-ids-exhausted";

const tag = (token: XmlToken | undefined) =>
  token?.kind === "open" || token?.kind === "empty" ? token : undefined;

const decoder = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();

export const partText = (entries: ReadonlyArray<DocxEntry>, name: string): string | null => {
  const entry = entries.find((candidate) => candidate.name === name);
  if (entry === undefined) return null;
  try {
    return decoder.decode(entry.bytes);
  } catch {
    throw new OoxmlShapeError({ reason: "invalid UTF-8" });
  }
};

const safeTokens = (xml: string): ReadonlyArray<XmlToken> | null => {
  try {
    return tokenizeXml(xml);
  } catch (cause) {
    if (isOoxmlShapeError(cause)) return null;
    throw cause;
  }
};

const EXTERNAL_FIELD = /\b(?:INCLUDEPICTURE|INCLUDETEXT|LINK|DDE|DDEAUTO|IMPORT)\b/iu;

/**
 * Which inputs this operation accepts at all: a plain .docx whose main part is
 * `word/document.xml`, with no macros, no relationship or field that makes the renderer read or
 * fetch anything outside the package, and no embedded or alternative documents.
 */
export function refuseUnsupportedInput(entries: ReadonlyArray<DocxEntry>): DocxInputRefusal | null {
  if (entries.some((entry) => /(?:^|\/)vbaProject\.bin$/iu.test(entry.name)))
    return "macro-enabled";
  const contentTypes = partText(entries, "[Content_Types].xml");
  const rootRels = partText(entries, "_rels/.rels");
  const main = partText(entries, MAIN_PART);
  if (contentTypes === null || rootRels === null || main === null) return "not-a-word-document";
  const typeTokens = safeTokens(contentTypes);
  const relsTokens = safeTokens(rootRels);
  if (typeTokens === null || relsTokens === null) return "malformed-part";
  const contentType = typeTokens
    .map(tag)
    .find(
      (token) =>
        token?.name === "Override" &&
        token.attributes.get("PartName")?.toLowerCase() === `/${MAIN_PART}`,
    )
    ?.attributes.get("ContentType");
  if (contentType !== WORD_MAIN_TYPE)
    return /macroEnabled/iu.test(contentType ?? "") ? "macro-enabled" : "not-a-word-document";
  const officeDocument = relsTokens
    .map(tag)
    .filter(
      (token) =>
        token?.name === "Relationship" &&
        /\/officeDocument$/u.test(token.attributes.get("Type") ?? ""),
    );
  if (
    officeDocument.length !== 1 ||
    officeDocument[0]?.attributes.get("Target")?.replace(/^\//u, "") !== MAIN_PART
  )
    return "not-a-word-document";

  for (const entry of entries) {
    const name = entry.name.toLowerCase();
    if (!name.endsWith(".rels") && !(name.startsWith("word/") && name.endsWith(".xml"))) continue;
    const xml = partText(entries, entry.name);
    const tokens = xml === null ? null : safeTokens(xml);
    if (tokens === null) return "malformed-part";
    let instruction = false;
    for (const token of tokens) {
      if (token.kind === "open" || token.kind === "empty") {
        if (
          token.name === "Relationship" &&
          token.attributes.get("TargetMode") === "External" &&
          !/\/hyperlink$/u.test(token.attributes.get("Type") ?? "")
        )
          return "external-resources";
        if (token.name === "w:altChunk" || token.name === "w:subDoc") return "embedded-documents";
        if (
          token.name === "w:fldSimple" &&
          EXTERNAL_FIELD.test(token.attributes.get("w:instr") ?? "")
        )
          return "external-fields";
        instruction = token.kind === "open" && token.name === "w:instrText";
      } else if (token.kind === "text") {
        if (instruction && EXTERNAL_FIELD.test(token.text)) return "external-fields";
      } else if (token.kind === "close") {
        instruction = false;
      }
    }
  }
  return null;
}

interface RunInfo {
  readonly openIndex: number;
  readonly closeIndex: number;
  readonly rPr: string;
  readonly eligible: boolean;
}

interface TextSegment {
  readonly offset: number;
  readonly text: string;
  readonly run: RunInfo | null;
}

interface ParagraphText {
  readonly openIndex: number;
  readonly segments: ReadonlyArray<TextSegment>;
  readonly text: string;
  readonly rightToLeft: boolean;
}

const HIDDEN_ANCESTORS = new Set(["w:del", "w:moveFrom", "mc:Fallback"]);
const UNEDITABLE_ANCESTORS = new Set([
  "w:ins",
  "w:del",
  "w:moveFrom",
  "w:moveTo",
  "w:fldSimple",
  "mc:AlternateContent",
]);

function describeRun(
  tokens: ReadonlyArray<XmlToken>,
  openIndex: number,
  xml: string,
  editableContext: boolean,
): RunInfo {
  const closeIndex = matchingClose(tokens, openIndex);
  let rPr = "";
  let texts = 0;
  let eligible = editableContext;
  for (let index = openIndex + 1; index < closeIndex; index += 1) {
    const child = tokens[index]!;
    if (child.kind === "text") continue;
    const opened = tag(child);
    if (opened === undefined) {
      eligible = false;
      continue;
    }
    const end = matchingClose(tokens, index);
    if (opened.name === "w:rPr" && texts === 0 && rPr === "") {
      rPr = xml.slice(opened.start, tokens[end]!.end);
      for (let inner = index; inner <= end; inner += 1) {
        if (tag(tokens[inner])?.attributes.has("w:id")) eligible = false;
      }
    } else if (
      opened.name === "w:t" &&
      texts === 0 &&
      [...opened.attributes.keys()].every((name) => name === "xml:space")
    ) {
      texts += 1;
    } else {
      eligible = false;
    }
    index = end;
  }
  return { openIndex, closeIndex, rPr, eligible: eligible && texts === 1 };
}

/** Visible text by paragraph, innermost paragraph first-class, with the runs that hold it. */
function paragraphTexts(
  tokens: ReadonlyArray<XmlToken>,
  xml: string,
): ReadonlyArray<ParagraphText> {
  const stack: string[] = [];
  const runs: (RunInfo | null)[] = [];
  const open: { openIndex: number; segments: TextSegment[]; text: string; rightToLeft: boolean }[] =
    [];
  const done: ParagraphText[] = [];
  let fieldDepth = 0;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token.kind === "open" || token.kind === "empty") {
      if (token.name === "w:fldChar") {
        const type = token.attributes.get("w:fldCharType");
        if (type === "begin") fieldDepth += 1;
        else if (type === "end") fieldDepth = Math.max(0, fieldDepth - 1);
      }
      if (token.name === "w:bidi" && stack.at(-1) === "w:pPr" && stack.at(-2) === "w:p") {
        const value = token.attributes.get("w:val");
        if (open.length > 0) open.at(-1)!.rightToLeft = value !== "0" && value !== "false";
      }
      if (token.kind === "empty") continue;
      if (token.name === "w:p")
        open.push({ openIndex: index, segments: [], text: "", rightToLeft: false });
      if (token.name === "w:r") {
        const editable =
          stack.at(-1) === "w:p" &&
          fieldDepth === 0 &&
          !stack.some((name) => UNEDITABLE_ANCESTORS.has(name));
        runs.push(describeRun(tokens, index, xml, editable));
      }
      stack.push(token.name);
    } else if (token.kind === "close") {
      stack.pop();
      if (token.name === "w:r") runs.pop();
      if (token.name === "w:p") {
        const paragraph = open.pop();
        if (paragraph !== undefined) done.push(paragraph);
      }
    } else if (token.kind === "text" && stack.at(-1) === "w:t" && open.length > 0) {
      if (stack.some((name) => HIDDEN_ANCESTORS.has(name))) continue;
      const paragraph = open.at(-1)!;
      paragraph.segments.push({
        offset: paragraph.text.length,
        text: token.text,
        run: stack.at(-2) === "w:r" ? (runs.at(-1) ?? null) : null,
      });
      paragraph.text += token.text;
    }
  }
  return done;
}

const occurrences = (text: string, find: string): number[] => {
  const found: number[] = [];
  for (let at = text.indexOf(find); at !== -1; at = text.indexOf(find, at + 1)) found.push(at);
  return found;
};

const maxRevisionId = (tokens: ReadonlyArray<XmlToken>): number => {
  let max = 0;
  for (const token of tokens) {
    const id = tag(token)?.attributes.get("w:id");
    if (id !== undefined && /^\d{1,10}$/u.test(id)) max = Math.max(max, Number(id));
  }
  return max;
};

export type TrackedReplacementEdit =
  | { readonly _tag: "refused"; readonly reason: DocxEditRefusal; readonly occurrences?: number }
  | {
      readonly _tag: "edited";
      readonly xml: string;
      readonly deletionId: string;
      readonly insertionId: string;
      /** The replacement begins or ends with a direction-neutral character in an RTL paragraph. */
      readonly neutralAtRightToLeftEdge: boolean;
    };

/** One tracked deletion and insertion replacing the single occurrence of `find`. */
export function applyTrackedReplacement(
  xml: string,
  request: TrackedReplacementRequest,
): TrackedReplacementEdit {
  const tokens = safeTokens(xml);
  const root = tokens?.find((token) => token.kind === "open");
  if (
    tokens === null ||
    root?.kind !== "open" ||
    root.name !== "w:document" ||
    root.attributes.get("xmlns:w") !== W_NS
  )
    return { _tag: "refused", reason: "malformed-part" };
  const paragraphs = paragraphTexts(tokens, xml);
  const hits = paragraphs.flatMap((paragraph) =>
    occurrences(paragraph.text, request.find).map((at) => ({ paragraph, at })),
  );
  if (hits.length === 0) return { _tag: "refused", reason: "text-not-found" };
  if (hits.length > 1)
    return { _tag: "refused", reason: "text-ambiguous", occurrences: hits.length };
  const { paragraph, at } = hits[0]!;
  const segment = paragraph.segments.find(
    (candidate) =>
      candidate.offset <= at &&
      at + request.find.length <= candidate.offset + candidate.text.length,
  );
  if (segment === undefined) return { _tag: "refused", reason: "text-spans-runs" };
  if (segment.run === null || !segment.run.eligible)
    return { _tag: "refused", reason: "unsupported-run" };
  const maxId = maxRevisionId(tokens);
  if (maxId + 2 > MAX_REVISION_ID) return { _tag: "refused", reason: "revision-ids-exhausted" };

  const runOpen = tokens[segment.run.openIndex]!;
  const runClose = tokens[segment.run.closeIndex]!;
  const runStart = xml.slice(runOpen.start, runOpen.end);
  const local = at - segment.offset;
  const before = segment.text.slice(0, local);
  const after = segment.text.slice(local + request.find.length);
  const run = (element: "w:t" | "w:delText", text: string) =>
    `${runStart}${segment.run!.rPr}<${element} xml:space="preserve">${escapeXmlText(text)}</${element}></w:r>`;
  const attributes = `w:author="${escapeXmlAttribute(request.author)}" w:date="${escapeXmlAttribute(request.date)}"`;
  const deletionId = String(maxId + 1);
  const insertionId = String(maxId + 2);
  const replacement = [
    before === "" ? "" : run("w:t", before),
    `<w:del w:id="${deletionId}" ${attributes}>${run("w:delText", request.find)}</w:del>`,
    `<w:ins w:id="${insertionId}" ${attributes}>${run("w:t", request.replace)}</w:ins>`,
    after === "" ? "" : run("w:t", after),
  ].join("");
  return {
    _tag: "edited",
    xml: xml.slice(0, runOpen.start) + replacement + xml.slice(runClose.end),
    deletionId,
    insertionId,
    neutralAtRightToLeftEdge:
      paragraph.rightToLeft && /^[^\p{L}\p{N}]|[^\p{L}\p{N}]$/u.test(request.replace),
  };
}

export interface IntegrityCheck {
  readonly id:
    | "package-parts-preserved"
    | "main-part-well-formed"
    | "single-paragraph-changed"
    | "tracked-revision-marked"
    | "rejection-restores-source"
    | "acceptance-applies-replacement"
    | "document-features-preserved";
  readonly passed: boolean;
  readonly detail?: string;
}

interface Revision {
  readonly kind: "ins" | "del";
  readonly id: string;
  readonly author: string;
  readonly date: string;
}

type Logical =
  | {
      readonly k: "char";
      readonly c: string;
      readonly rPr: string;
      readonly rev: Revision | null;
      readonly deleted: boolean;
    }
  | { readonly k: "mark"; readonly raw: string; readonly rev: Revision | null };

const TRANSPARENT = new Set([
  "w:hyperlink",
  "w:smartTag",
  "w:customXml",
  "w:sdt",
  "w:sdtContent",
  "w:fldSimple",
  "w:moveFrom",
  "w:moveTo",
  "w:dir",
  "w:bdo",
]);

/** A paragraph as characters with their run properties and every other element verbatim. */
function logicalParagraph(
  tokens: ReadonlyArray<XmlToken>,
  xml: string,
  openIndex: number,
): ReadonlyArray<Logical> {
  const closeIndex = matchingClose(tokens, openIndex);
  const out: Logical[] = [];
  const revisions: (Revision | null)[] = [];
  const containers: string[] = [];
  const rev = () => revisions.findLast((entry) => entry !== null) ?? null;
  const outer = (index: number) =>
    xml.slice(tokens[index]!.start, tokens[matchingClose(tokens, index)]!.end);
  let run: { rPr: string } | null = null;
  for (let index = openIndex + 1; index < closeIndex; index += 1) {
    const token = tokens[index]!;
    if (token.kind === "text") continue;
    if (token.kind === "close") {
      if (token.name === "w:r") run = null;
      else if (token.name === "w:ins" || token.name === "w:del") revisions.pop();
      else if (containers.at(-1) === token.name) {
        containers.pop();
        out.push({ k: "mark", raw: `</${token.name}>`, rev: rev() });
      }
      continue;
    }
    if (token.kind === "other") continue;
    if (run !== null) {
      if (token.name === "w:rPr") {
        run.rPr = outer(index);
      } else if ((token.name === "w:t" || token.name === "w:delText") && token.kind === "open") {
        const end = matchingClose(tokens, index);
        const deleted = token.name === "w:delText";
        for (let inner = index + 1; inner < end; inner += 1) {
          const text = tokens[inner]!;
          if (text.kind !== "text") continue;
          for (const c of text.text) out.push({ k: "char", c, rPr: run.rPr, rev: rev(), deleted });
        }
      } else if (token.name !== "w:t" && token.name !== "w:delText") {
        out.push({ k: "mark", raw: `${run.rPr}|${outer(index)}`, rev: rev() });
      }
      index = matchingClose(tokens, index);
      continue;
    }
    if (token.kind === "open" && token.name === "w:r") {
      run = { rPr: "" };
      continue;
    }
    if (token.kind === "open" && (token.name === "w:ins" || token.name === "w:del")) {
      revisions.push({
        kind: token.name === "w:ins" ? "ins" : "del",
        id: token.attributes.get("w:id") ?? "",
        author: token.attributes.get("w:author") ?? "",
        date: token.attributes.get("w:date") ?? "",
      });
      continue;
    }
    if (token.kind === "open" && TRANSPARENT.has(token.name)) {
      containers.push(token.name);
      out.push({ k: "mark", raw: xml.slice(token.start, token.end), rev: rev() });
      continue;
    }
    out.push({ k: "mark", raw: outer(index), rev: rev() });
    index = matchingClose(tokens, index);
  }
  return out;
}

const same = (a: ReadonlyArray<Logical>, b: ReadonlyArray<Logical>) =>
  JSON.stringify(a) === JSON.stringify(b);

function innermostParagraph(tokens: ReadonlyArray<XmlToken>, from: number, to: number) {
  let found: number | undefined;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token.kind !== "open" || token.name !== "w:p") continue;
    if (token.start > from) break;
    if (tokens[matchingClose(tokens, index)]!.end >= to) found = index;
  }
  return found;
}

export interface DocxInventory {
  readonly commentAnchors: number;
  readonly equations: number;
  readonly tables: number;
  readonly rightToLeftTables: number;
  readonly repeatedHeaderRows: number;
  readonly rightToLeftParagraphs: number;
  readonly pageBreaks: number;
  readonly sections: number;
  readonly insertions: number;
  readonly deletions: number;
  readonly hebrewLetters: number;
}

export function docxInventory(xml: string): DocxInventory {
  const tokens = tokenizeXml(xml);
  const counts = {
    commentAnchors: 0,
    equations: 0,
    tables: 0,
    rightToLeftTables: 0,
    repeatedHeaderRows: 0,
    rightToLeftParagraphs: 0,
    pageBreaks: 0,
    sections: 0,
    insertions: 0,
    deletions: 0,
    hebrewLetters: 0,
  };
  let parent: string | undefined;
  const stack: string[] = [];
  for (const token of tokens) {
    if (token.kind === "text") {
      if (stack.at(-1) === "w:t" || stack.at(-1) === "w:delText")
        counts.hebrewLetters += token.text.match(/[א-ת]/gu)?.length ?? 0;
      continue;
    }
    if (token.kind === "close") {
      stack.pop();
      continue;
    }
    if (token.kind === "other") continue;
    parent = stack.at(-1);
    if (token.kind === "open") stack.push(token.name);
    switch (token.name) {
      case "w:commentRangeStart":
      case "w:commentRangeEnd":
      case "w:commentReference":
        counts.commentAnchors += 1;
        break;
      case "m:oMath":
        counts.equations += 1;
        break;
      case "w:tbl":
        counts.tables += 1;
        break;
      case "w:bidiVisual":
        counts.rightToLeftTables += 1;
        break;
      case "w:tblHeader":
        counts.repeatedHeaderRows += 1;
        break;
      case "w:bidi":
        if (parent === "w:pPr") counts.rightToLeftParagraphs += 1;
        break;
      case "w:lastRenderedPageBreak":
        counts.pageBreaks += 1;
        break;
      case "w:br":
        if (token.attributes.get("w:type") === "page") counts.pageBreaks += 1;
        break;
      case "w:sectPr":
        counts.sections += 1;
        break;
      case "w:ins":
        counts.insertions += 1;
        break;
      case "w:del":
        counts.deletions += 1;
        break;
    }
  }
  return counts;
}

const wellFormed = (xml: string): boolean => {
  try {
    const parser = new SaxesParser({ xmlns: true });
    let failed = false;
    parser.on("error", () => {
      failed = true;
    });
    parser.write(xml).close();
    return !failed;
  } catch {
    return false;
  }
};

const bytesEqual = (a: Uint8Array, b: Uint8Array) =>
  a.byteLength === b.byteLength && a.every((value, index) => value === b[index]);

export interface TrackedReplacementVerification {
  readonly checks: ReadonlyArray<IntegrityCheck>;
  readonly passed: boolean;
  readonly deletionId: string | null;
  readonly insertionId: string | null;
  readonly source: DocxInventory | null;
  readonly candidate: DocxInventory | null;
}

/**
 * Proves the candidate from the source alone: every other part and every byte outside one
 * paragraph is unchanged, rejecting the new revisions restores that paragraph exactly, and
 * accepting them gives the source with the one occurrence replaced.
 */
export function verifyTrackedReplacement(
  sourceEntries: ReadonlyArray<DocxEntry>,
  candidateEntries: ReadonlyArray<DocxEntry>,
  request: TrackedReplacementRequest,
): TrackedReplacementVerification {
  const checks: IntegrityCheck[] = [];
  const result = (
    deletionId: string | null = null,
    insertionId: string | null = null,
    source: DocxInventory | null = null,
    candidate: DocxInventory | null = null,
  ): TrackedReplacementVerification => ({
    checks,
    passed: checks.length === 7 && checks.every((check) => check.passed),
    deletionId,
    insertionId,
    source,
    candidate,
  });

  const partsPreserved =
    sourceEntries.length === candidateEntries.length &&
    sourceEntries.every((entry, index) => {
      const other = candidateEntries[index];
      return (
        other !== undefined &&
        other.name === entry.name &&
        (entry.name === MAIN_PART || bytesEqual(entry.bytes, other.bytes))
      );
    });
  checks.push({ id: "package-parts-preserved", passed: partsPreserved });

  let sourceXml: string | null;
  let candidateXml: string | null;
  try {
    sourceXml = partText(sourceEntries, MAIN_PART);
    candidateXml = partText(candidateEntries, MAIN_PART);
  } catch {
    sourceXml = null;
    candidateXml = null;
  }
  const formed = candidateXml !== null && sourceXml !== null && wellFormed(candidateXml);
  checks.push({ id: "main-part-well-formed", passed: formed });
  const sourceTokens = sourceXml === null ? null : safeTokens(sourceXml);
  const candidateTokens = candidateXml === null ? null : safeTokens(candidateXml);
  if (!formed || sourceTokens === null || candidateTokens === null) return result();
  const src = sourceXml!;
  const cand = candidateXml!;

  let prefix = 0;
  const shorter = Math.min(src.length, cand.length);
  while (prefix < shorter && src[prefix] === cand[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < shorter - prefix &&
    src[src.length - 1 - suffix] === cand[cand.length - 1 - suffix]
  )
    suffix += 1;
  const sourceParagraph =
    prefix === src.length && src.length === cand.length
      ? undefined
      : innermostParagraph(sourceTokens, prefix, src.length - suffix);
  const candidateParagraph =
    sourceParagraph === undefined
      ? undefined
      : innermostParagraph(candidateTokens, prefix, cand.length - suffix);
  const located =
    sourceParagraph !== undefined &&
    candidateParagraph !== undefined &&
    sourceTokens[sourceParagraph]!.start === candidateTokens[candidateParagraph]!.start;
  checks.push({ id: "single-paragraph-changed", passed: located });
  if (!located) return result();

  const sourceIds = new Set(
    sourceTokens.flatMap((token) => {
      const id = tag(token)?.attributes.get("w:id");
      return id === undefined ? [] : [id];
    }),
  );
  const candidateLogical = logicalParagraph(candidateTokens, cand, candidateParagraph!);
  const added = new Map<string, Revision>();
  for (const entry of candidateLogical) {
    if (entry.rev !== null && !sourceIds.has(entry.rev.id)) added.set(entry.rev.id, entry.rev);
  }
  const revisions = [...added.values()];
  const deletion = revisions.find((revision) => revision.kind === "del");
  const insertion = revisions.find((revision) => revision.kind === "ins");
  const idUses = (id: string) =>
    candidateTokens.filter((token) => tag(token)?.attributes.get("w:id") === id).length;
  const marked =
    revisions.length === 2 &&
    deletion !== undefined &&
    insertion !== undefined &&
    revisions.every(
      (revision) =>
        revision.author === request.author &&
        revision.date === request.date &&
        idUses(revision.id) === 1,
    );
  checks.push({ id: "tracked-revision-marked", passed: marked });
  if (!marked) return result();
  const ours = new Set([deletion.id, insertion.id]);

  const sourceLogical = logicalParagraph(sourceTokens, src, sourceParagraph!);
  const rejected = candidateLogical.flatMap((entry): Logical[] => {
    if (entry.rev === null || !ours.has(entry.rev.id)) return [entry];
    if (entry.rev.kind === "ins") return [];
    return [entry.k === "char" ? { ...entry, rev: null, deleted: false } : { ...entry, rev: null }];
  });
  checks.push({ id: "rejection-restores-source", passed: same(rejected, sourceLogical) });

  const accepted = candidateLogical.flatMap((entry): Logical[] => {
    if (entry.rev === null || !ours.has(entry.rev.id)) return [entry];
    if (entry.rev.kind === "del") return [];
    return [{ ...entry, rev: null }];
  });
  const documentHits = paragraphTexts(sourceTokens, src).reduce(
    (count, paragraph) => count + occurrences(paragraph.text, request.find).length,
    0,
  );
  const visible: number[] = [];
  sourceLogical.forEach((entry, index) => {
    if (entry.k === "char" && !entry.deleted && entry.rev?.kind !== "del") visible.push(index);
  });
  const visibleText = visible.map((index) => (sourceLogical[index] as { c: string }).c).join("");
  const hits = occurrences(visibleText, request.find);
  let expected: Logical[] | null = null;
  if (documentHits === 1 && hits.length === 1) {
    const length = [...request.find].length;
    const startChar = Array.from(visibleText.slice(0, hits[0])).length;
    const span = visible.slice(startChar, startChar + length);
    const first = sourceLogical[span[0]!];
    const contiguous = span.every((value, offset) => value === span[0]! + offset);
    if (
      contiguous &&
      first?.k === "char" &&
      span.every((index) => {
        const entry = sourceLogical[index];
        return entry?.k === "char" && entry.rPr === first.rPr && entry.rev === null;
      })
    ) {
      expected = [
        ...sourceLogical.slice(0, span[0]),
        ...[...request.replace].map((c): Logical => ({
          k: "char",
          c,
          rPr: first.rPr,
          rev: null,
          deleted: false,
        })),
        ...sourceLogical.slice(span.at(-1)! + 1),
      ];
    }
  }
  checks.push({
    id: "acceptance-applies-replacement",
    passed: expected !== null && same(accepted, expected),
  });

  const sourceInventory = docxInventory(src);
  const candidateInventory = docxInventory(cand);
  const hebrewAdded = request.replace.match(/[א-ת]/gu)?.length ?? 0;
  const featuresPreserved = (Object.keys(sourceInventory) as Array<keyof DocxInventory>).every(
    (key) =>
      candidateInventory[key] ===
      sourceInventory[key] +
        (key === "insertions" || key === "deletions"
          ? 1
          : key === "hebrewLetters"
            ? hebrewAdded
            : 0),
  );
  checks.push({
    id: "document-features-preserved",
    passed: featuresPreserved,
    ...(featuresPreserved
      ? {}
      : { detail: "A comment anchor, equation, table, break, section or revision count changed." }),
  });
  return result(deletion.id, insertion.id, sourceInventory, candidateInventory);
}

export const encodePart = (xml: string): Uint8Array => encoder.encode(xml);
