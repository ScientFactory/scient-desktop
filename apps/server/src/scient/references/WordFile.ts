// @effect-diagnostics nodeBuiltinImport:off -- A Word file's parts are read from the zip's Node streams.
import * as NodePath from "node:path";
import * as NodeStreamConsumers from "node:stream/consumers";

import type { WordCode, WordContent, WordParagraph } from "@scientfactory/scient-sources";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { SaxesParser } from "saxes";
import type * as Yauzl from "yauzl";

import { openZipArchive } from "../../zipArchive.ts";

/** Only the XML parts are read, never pictures; a part this large uncompressed is refused. */
const MAX_PART_BYTES = 32 * 1024 * 1024;

export class WordFileError extends Schema.TaggedError<WordFileError>()("WordFileError", {
  problem: Schema.Literals(["unreadable", "too-large"]),
}) {}

export const isWordFileError = Schema.is(WordFileError);

export interface WordFile {
  readonly content: WordContent;
  /** The file has tracked changes; it is read as if they were accepted. */
  readonly trackedChanges: boolean;
  /** The file has comments; they are not read. */
  readonly comments: boolean;
}

const local = (name: string) => name.slice(name.indexOf(":") + 1);

function walk(
  xml: string,
  handlers: {
    readonly open: (name: string, attribute: (name: string) => string | undefined) => void;
    readonly close?: (name: string) => void;
    readonly text?: (value: string) => void;
  },
): void {
  const parser = new SaxesParser();
  parser.on("opentag", (tag) => {
    const attributes = new Map(
      Object.entries(tag.attributes).map(([name, value]) => [local(name), String(value)]),
    );
    handlers.open(local(tag.name), (name) => attributes.get(name));
  });
  if (handlers.close) parser.on("closetag", (tag) => handlers.close!(local(tag.name)));
  if (handlers.text) {
    parser.on("text", handlers.text);
    parser.on("cdata", handlers.text);
  }
  parser.write(xml).close();
}

/** Style IDs are localized; the names Word stores for its built-in heading styles are not. */
function headingStyles(stylesXml: string | null): ReadonlySet<string> {
  const headings = new Set<string>();
  let styleId: string | undefined;
  if (stylesXml) {
    walk(stylesXml, {
      open: (name, attribute) => {
        if (name === "style") styleId = attribute("styleId");
        else if (
          name === "name" &&
          styleId &&
          /^(?:heading \d|title)$/iu.test(attribute("val") ?? "")
        )
          headings.add(styleId);
      },
    });
  }
  return headings;
}

/** Custom document properties by name; Zotero keeps a bookmark citation's code in them. */
function customProperties(customXml: string | null): ReadonlyMap<string, string> {
  const properties = new Map<string, string>();
  let name: string | undefined;
  if (customXml) {
    walk(customXml, {
      open: (tag, attribute) => {
        if (tag === "property") name = attribute("name");
      },
      close: (tag) => {
        if (tag === "property") name = undefined;
      },
      text: (value) => {
        if (name !== undefined) properties.set(name, (properties.get(name) ?? "") + value);
      },
    });
  }
  return properties;
}

/**
 * Content the document no longer shows or shows elsewhere: tracked deletions (with the content
 * controls, bookmarks and fields inside them), text moved away, and a text box's fallback copy.
 */
const HIDDEN = new Set(["del", "moveFrom", "Fallback"]);
const TRACKED = new Set(["ins", "del", "moveFrom", "moveTo"]);

interface Reading {
  readonly paragraphs: Array<WordParagraph>;
  readonly codes: Array<WordCode>;
  readonly bookmarks: Array<string>;
  trackedChanges: boolean;
}

/** One part's paragraphs and field codes, in document order. Fields span runs and paragraphs. */
function readPart(xml: string, headings: ReadonlySet<string>, reading: Reading): void {
  const open: Array<{
    text: string;
    superscripts: Array<string>;
    superscriptOpen: boolean;
    heading: boolean;
    inTable: boolean;
  }> = [];
  const fields: Array<{ instruction: string; data: string | null; separated: boolean }> = [];
  let hidden = 0;
  let tables = 0;
  let capture: "t" | "instrText" | "fldData" | null = null;
  let superscript = false;
  const shown = () => hidden === 0 && fields.every((field) => field.separated);
  const write = (value: string) => {
    const paragraph = open.at(-1);
    if (!paragraph || !shown() || value === "") return;
    paragraph.text += value;
    if (!superscript) paragraph.superscriptOpen = false;
    else if (paragraph.superscriptOpen)
      paragraph.superscripts[paragraph.superscripts.length - 1] += value;
    else {
      paragraph.superscripts.push(value);
      paragraph.superscriptOpen = true;
    }
  };
  walk(xml, {
    open: (name, attribute) => {
      if (TRACKED.has(name)) reading.trackedChanges = true;
      if (HIDDEN.has(name)) hidden++;
      if (hidden > 0) return;
      if (name === "tbl") tables++;
      else if (name === "p")
        open.push({
          text: "",
          superscripts: [],
          superscriptOpen: false,
          heading: false,
          inTable: tables > 0,
        });
      else if (name === "pStyle") {
        const paragraph = open.at(-1);
        if (paragraph && headings.has(attribute("val") ?? "")) paragraph.heading = true;
      } else if (name === "r") superscript = false;
      else if (name === "vertAlign") superscript = attribute("val") === "superscript";
      else if (name === "t" || name === "instrText" || name === "fldData") capture = name;
      else if (name === "tab") write("\t");
      else if (name === "br" || name === "cr") write("\n");
      else if (name === "noBreakHyphen") write("‑");
      else if (name === "fldSimple")
        reading.codes.push({ instruction: attribute("instr") ?? "", data: null });
      else if (name === "tag")
        reading.codes.push({ instruction: attribute("val") ?? "", data: null });
      else if (name === "bookmarkStart") reading.bookmarks.push(attribute("name") ?? "");
      else if (name === "fldChar") {
        const type = attribute("fldCharType");
        if (type === "begin") fields.push({ instruction: "", data: null, separated: false });
        else if (type === "separate" && fields.length > 0) fields.at(-1)!.separated = true;
        else if (type === "end") {
          const field = fields.pop();
          if (field) reading.codes.push({ instruction: field.instruction, data: field.data });
        }
      }
    },
    close: (name) => {
      if (HIDDEN.has(name)) hidden--;
      if (hidden > 0) return;
      if (name === "t" || name === "instrText" || name === "fldData") capture = null;
      else if (name === "tbl") tables--;
      else if (name === "p") {
        const { text, superscripts, heading, inTable } = open.pop()!;
        reading.paragraphs.push({ text, superscripts, heading, inTable });
      }
    },
    text: (value) => {
      if (hidden > 0 || capture === null) return;
      const field = fields.at(-1);
      if (capture === "t") write(value);
      else if (!field || field.separated) return;
      else if (capture === "instrText") field.instruction += value;
      else field.data = (field.data ?? "") + value;
    },
  });
  // A field the part never closes still holds its citation.
  for (const field of fields)
    reading.codes.push({ instruction: field.instruction, data: field.data });
}

function parse(parts: {
  readonly document: string;
  readonly notes: ReadonlyArray<string>;
  readonly styles: string | null;
  readonly custom: string | null;
  readonly comments: string | null;
}): WordFile {
  const headings = headingStyles(parts.styles);
  const reading: Reading = { paragraphs: [], codes: [], bookmarks: [], trackedChanges: false };
  readPart(parts.document, headings, reading);
  const body = reading.paragraphs.length;
  for (const xml of parts.notes) readPart(xml, headings, reading);
  const properties = customProperties(parts.custom);
  for (const bookmark of reading.bookmarks) {
    let instruction = "";
    for (let part = 1; properties.has(`${bookmark}_${part}`); part++)
      instruction += properties.get(`${bookmark}_${part}`);
    if (instruction) reading.codes.push({ instruction, data: null });
  }
  return {
    content: {
      paragraphs: reading.paragraphs.slice(0, body),
      notes: reading.paragraphs.slice(body),
      codes: reading.codes,
    },
    trackedChanges: reading.trackedChanges,
    comments: /<(?:\w+:)?comment[\s>]/u.test(parts.comments ?? ""),
  };
}

const unreadable = () => new WordFileError({ problem: "unreadable" });

const readParts = Effect.fn("WordFile.readParts")(function* (path: string) {
  const archive = yield* openZipArchive(path, unreadable);
  const entries = new Map<string, Yauzl.Entry>();
  for (;;) {
    const entry = yield* archive.next;
    if (entry === null) break;
    entries.set(entry.fileName, entry);
  }
  const part = Effect.fn("WordFile.readPart")(function* (name: string) {
    const entry = entries.get(name);
    if (!entry) return null;
    if (entry.uncompressedSize > MAX_PART_BYTES) {
      return yield* new WordFileError({ problem: "too-large" });
    }
    const readable = yield* archive.streamEntry(entry);
    return yield* Effect.tryPromise({
      try: () => NodeStreamConsumers.text(readable),
      catch: unreadable,
    });
  });
  // The package names its main part; Word writes word/document.xml, other writers need not.
  const relationships = (yield* part("_rels/.rels")) ?? "";
  const main =
    [...relationships.matchAll(/<Relationship\b[^>]*>/gu)]
      .filter(([tag]) => /Type="[^"]*\/officeDocument"/u.test(tag))
      .map(([tag]) => /Target="\/?([^"]+)"/u.exec(tag)?.[1])
      .find((target) => target !== undefined) ?? "word/document.xml";
  const beside = (name: string) => part(NodePath.posix.join(NodePath.posix.dirname(main), name));
  const document = yield* part(main);
  if (document === null) return yield* unreadable();
  const notes = [yield* beside("footnotes.xml"), yield* beside("endnotes.xml")];
  return {
    document,
    notes: notes.filter((xml) => xml !== null),
    styles: yield* beside("styles.xml"),
    custom: yield* part("docProps/custom.xml"),
    comments: yield* beside("comments.xml"),
  };
});

/** Reads a `.docx` at an already guarded path; the error says why it could not be read. */
export function readWordFile(path: string): Promise<WordFile | WordFileError> {
  return Effect.runPromise(
    Effect.scoped(readParts(path)).pipe(
      Effect.flatMap((parts) => Effect.try({ try: () => parse(parts), catch: unreadable })),
      Effect.match({ onFailure: (error) => error, onSuccess: (file) => file }),
    ),
  );
}
