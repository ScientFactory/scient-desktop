/**
 * CommonMark lacks citations and Pandoc Markdown misreads Scient's other syntax. Build Cite nodes
 * only when every key has a bundled CSL reference; otherwise retain authored text and report
 * unformatted keys instead of silently changing meaning.
 */
import type { CslItem, DocumentCitation, DocumentWarning } from "@t3tools/contracts";

import { forEachInlineList, textInlines, type PandocNode } from "./pandocAst.ts";

/** A CSL-JSON item as Pandoc's `--citeproc` reads it from a `.json` bibliography. */
export type CslJsonItem = CslItem;

/**
 * The bundle's formattable references, keyed by citation key. The item's `id`
 * becomes the key, which is what a `Cite` node names; the first reference for
 * a key wins.
 */
export function bibliographyFromCitations(
  citations: ReadonlyArray<DocumentCitation>,
): ReadonlyMap<string, CslJsonItem> {
  const entries = new Map<string, CslJsonItem>();
  for (const citation of citations) {
    if (citation._tag !== "bibliographic" || citation.reference === null) continue;
    if (entries.has(citation.key)) continue;
    entries.set(citation.key, { ...citation.reference, id: citation.key });
  }
  return entries;
}

const CITATION_GROUP = /\[([^[\]]*@[^[\]]*)\]/gu;
/**
 * One item of a group: optional prefix ending in whitespace, optional `-`,
 * `@key` (letters, digits, `_`, and internal `:.#-`), then the suffix. The `@`
 * must start the item or follow whitespace, as in Scient's editor, so an email
 * address is never read as a citation.
 */
const CITATION_ITEM =
  /^(|[\s\S]*\s)(-)?@([\p{L}\p{N}_](?:[\p{L}\p{N}_:.#-]*[\p{L}\p{N}_])?)([\s\S]*)$/u;

interface ParsedItem {
  readonly prefix: string;
  readonly suppressAuthor: boolean;
  readonly key: string;
  readonly suffix: string;
}

function parseGroup(content: string): ReadonlyArray<ParsedItem> | null {
  const items: Array<ParsedItem> = [];
  for (const part of content.split(";")) {
    const match = CITATION_ITEM.exec(part.trim());
    if (!match) return null;
    items.push({
      prefix: (match[1] ?? "").trim(),
      suppressAuthor: match[2] === "-",
      key: match[3] ?? "",
      suffix: (match[4] ?? "").trimEnd(),
    });
  }
  return items.length > 0 ? items : null;
}

const isTextInline = (node: PandocNode) =>
  node.t === "Str" || node.t === "Space" || node.t === "SoftBreak";

export interface CitationReport {
  readonly citedKeys: ReadonlySet<string>;
  readonly warnings: ReadonlyArray<DocumentWarning>;
}

/** Rewrites citation groups into `Cite` nodes in place. */
export function applyCitations(
  blocks: Array<PandocNode>,
  bibliography: ReadonlyMap<string, CslJsonItem>,
): CitationReport {
  const citedKeys = new Set<string>();
  const missing = new Set<string>();
  let noteNumber = 0;

  const citeRun = (run: ReadonlyArray<PandocNode>): Array<PandocNode> | null => {
    const text = run
      .map((node) => (node.t === "Str" && typeof node.c === "string" ? node.c : " "))
      .join("");
    if (!text.includes("@")) return null;
    const out: Array<PandocNode> = [];
    let cursor = 0;
    let changed = false;
    for (const match of text.matchAll(CITATION_GROUP)) {
      const items = parseGroup(match[1] ?? "");
      if (items === null) continue;
      const unknown = items.filter((item) => !bibliography.has(item.key));
      if (unknown.length > 0) {
        for (const item of unknown) missing.add(item.key);
        continue;
      }
      noteNumber += 1;
      const citations = items.map((item) => {
        citedKeys.add(item.key);
        return {
          citationId: item.key,
          citationPrefix: textInlines(item.prefix),
          citationSuffix: textInlines(item.suffix),
          citationMode: { t: item.suppressAuthor ? "SuppressAuthor" : "NormalCitation" },
          citationNoteNum: noteNumber,
          citationHash: 0,
        };
      });
      out.push(...textInlines(text.slice(cursor, match.index)));
      out.push({ t: "Cite", c: [citations, textInlines(match[0])] });
      cursor = match.index + match[0].length;
      changed = true;
    }
    if (!changed) return null;
    out.push(...textInlines(text.slice(cursor)));
    return out;
  };

  forEachInlineList(blocks, (inlines) => {
    const result: Array<PandocNode> = [];
    let changed = false;
    for (let index = 0; index < inlines.length;) {
      const node = inlines[index]!;
      if (!isTextInline(node)) {
        result.push(node);
        index += 1;
        continue;
      }
      let end = index;
      while (end < inlines.length && isTextInline(inlines[end]!)) end += 1;
      const run = inlines.slice(index, end);
      const replaced = citeRun(run);
      if (replaced === null) result.push(...run);
      else {
        result.push(...replaced);
        changed = true;
      }
      index = end;
    }
    if (changed) inlines.splice(0, inlines.length, ...result);
  });

  const warnings: Array<DocumentWarning> = [];
  if (missing.size > 0) {
    const keys = [...missing].slice(0, 10).map((key) => `@${key}`);
    warnings.push({
      code: "unsupported-construct",
      message: `Citations without a reference in the document were kept as written: ${keys.join(", ")}${missing.size > 10 ? ", …" : ""}.`,
    });
  }
  return { citedKeys, warnings };
}
