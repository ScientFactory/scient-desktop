// @effect-diagnostics nodeBuiltinImport:off -- Mermaid rendering ids are content hashes computed with node:crypto.
/**
 * Preparation: shapes the tree Pandoc read from a Scient document bundle into
 * what Scient means, before the security pass and the Word writer see it.
 *
 * Pandoc does not share Scient's Markdown parser, so everything Scient's
 * profiles add is mapped here explicitly rather than left for Pandoc to guess:
 *
 * - conversation structure markers (`<!-- scient:message … -->`,
 *   `<!-- scient:part … -->`) give speaker headings a speaker style and tell
 *   work-log and reasoning `<details>` blocks apart; the markers themselves are
 *   removed;
 * - `<details>` blocks become divs whose summary survives as a bold first
 *   paragraph (the Word writer drops raw HTML, and with it the summary); work
 *   log and reasoning divs carry the `Scient Work Log` / `Scient Reasoning`
 *   styles, and work-log steps become paragraphs so the style applies to them;
 * - GitHub alerts get the `Scient Alert` style with their title in bold;
 * - task lists become `Scient Task List` paragraphs with ☐ / ☑ boxes;
 * - Mermaid fences become the bundle's rendered diagram image, or a clearly
 *   labelled, complete Mermaid source block when no image was captured;
 * - wide tables get content-proportional column widths.
 *
 * Citations and text direction live in their own modules.
 */
import * as NodeCrypto from "node:crypto";

import {
  DOCUMENT_ASSET_URL_PREFIX,
  type DocumentAsset,
  type DocumentMarkdownProfile,
  type DocumentWarning,
} from "@t3tools/contracts";
import * as Predicate from "effect/Predicate";
import { parseFragment, type DefaultTreeAdapterMap } from "parse5";

import {
  attr,
  attrOf,
  childBlockLists,
  customStyleDiv,
  customStyleSpan,
  div,
  hasClass,
  inlineText,
  inlinesOf,
  para,
  strong,
  str,
  space,
  tableCells,
  tableColumnSpecs,
  textInlines,
  type PandocNode,
} from "./pandocAst.ts";
import { PLACEHOLDER_STYLE } from "./pandocResources.ts";
import { sectionPropertiesXml } from "./scientReferenceDocument.ts";

export const SCIENT_WORD_STYLES = {
  workLog: "Scient Work Log",
  reasoning: "Scient Reasoning",
  alert: "Scient Alert",
  taskList: "Scient Task List",
  speakerUser: "Scient Speaker User",
  speakerAssistant: "Scient Speaker Assistant",
  placeholder: PLACEHOLDER_STYLE,
} as const;

/**
 * The asset id a document bundle gives the rendered image of a Mermaid fence:
 * `mermaid-` and the first 16 hex digits of the SHA-256 of the fence source
 * (without its final newline). Producers that render diagrams name the
 * `rendered-diagram` asset this way so Word export can find it.
 */
export function mermaidDiagramAssetId(source: string): string {
  const digest = NodeCrypto.createHash("sha256")
    .update(source.replace(/\r?\n$/u, ""), "utf8")
    .digest("hex");
  return `mermaid-${digest.slice(0, 16)}`;
}

const MARKER = /^<!-- scient:(message|part)((?: [a-z-]+=[^\s=]+)*) -->\s*$/u;
const DETAILS_OPEN = /^<details\b[^>]*>/iu;
const DETAILS_BLOCK_TAGS = new Set([
  "blockquote",
  "br",
  "dd",
  "div",
  "dl",
  "dt",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "li",
  "ol",
  "p",
  "pre",
  "section",
  "table",
  "td",
  "th",
  "tr",
  "ul",
]);
const DETAILS_OMIT_TAGS = new Set(["iframe", "object", "script", "style", "svg", "template"]);
type HtmlNode = DefaultTreeAdapterMap["node"];
type HtmlElement = DefaultTreeAdapterMap["element"];
const ALERT_KINDS = new Set(["note", "tip", "important", "warning", "caution"]);
/** Tables this wide get proportional columns; narrower ones fit as Pandoc lays them out. */
const WIDE_TABLE_COLUMNS = 6;

function parseMarker(text: string): { kind: string; fields: Map<string, string> } | null {
  const match = MARKER.exec(text.trim());
  if (!match) return null;
  const fields = new Map<string, string>();
  for (const pair of (match[2] ?? "").trim().split(" ").filter(Boolean)) {
    const at = pair.indexOf("=");
    if (at > 0) fields.set(pair.slice(0, at), pair.slice(at + 1));
  }
  return { kind: match[1] ?? "", fields };
}

function isHtmlElement(node: HtmlNode, tag: string): node is HtmlElement {
  return "tagName" in node && node.tagName.toLowerCase() === tag;
}

/** Retains visible HTML text as safe Word paragraphs, never raw HTML. */
function visibleHtmlBlocks(nodes: ReadonlyArray<HtmlNode>): Array<PandocNode> {
  const paragraphs: Array<PandocNode> = [];
  let pending = "";
  const flush = () => {
    const text = pending.replace(/\s+/gu, " ").trim();
    if (text) paragraphs.push(para(textInlines(text)));
    pending = "";
  };
  const queue: Array<{ node: HtmlNode; closing: boolean }> = nodes
    .toReversed()
    .map((node) => ({ node, closing: false }));
  while (queue.length > 0) {
    const { node, closing } = queue.pop()!;
    if (node.nodeName === "#text" && "value" in node) {
      pending += node.value;
      continue;
    }
    if (!("tagName" in node) || !("childNodes" in node)) continue;
    const tag = node.tagName.toLowerCase();
    if (DETAILS_OMIT_TAGS.has(tag)) continue;
    if (DETAILS_BLOCK_TAGS.has(tag)) flush();
    if (closing) continue;
    queue.push({ node, closing: true });
    for (const child of node.childNodes.toReversed()) queue.push({ node: child, closing: false });
  }
  flush();
  return paragraphs;
}

function detailsFrame(details: HtmlElement, kind: DetailsKind): DetailsFrame {
  const summary = details.childNodes.find((node) => isHtmlElement(node, "summary"));
  return {
    kind,
    summary: summary
      ? visibleHtmlBlocks(summary.childNodes)
          .map((block) => inlineText(block.c))
          .join(" ")
      : "",
    blocks: visibleHtmlBlocks(details.childNodes.filter((node) => !isHtmlElement(node, "summary"))),
  };
}

function rawHtml(block: PandocNode): string | null {
  if (block.t !== "RawBlock" || !Array.isArray(block.c)) return null;
  const [format, text] = block.c;
  return format === "html" && Predicate.isString(text) ? text : null;
}

/** Work-log steps as paragraphs: a list's items become their own blocks, in order. */
function flattenLists(blocks: ReadonlyArray<PandocNode>): Array<PandocNode> {
  const out: Array<PandocNode> = [];
  for (const block of blocks) {
    if (block.t === "BulletList" || block.t === "OrderedList") {
      for (const item of childBlockLists(block)) out.push(...flattenLists(item));
    } else if (block.t === "Plain") {
      out.push(para(inlinesOf(block) ?? []));
    } else {
      out.push(block);
    }
  }
  return out;
}

type DetailsKind = "work-log" | "reasoning" | null;

interface DetailsFrame {
  readonly kind: DetailsKind;
  readonly summary: string;
  readonly blocks: Array<PandocNode>;
}

function buildDetails(frame: DetailsFrame): PandocNode {
  const summary = frame.summary.length > 0 ? [para([strong(textInlines(frame.summary))])] : [];
  switch (frame.kind) {
    case "work-log":
      return customStyleDiv(SCIENT_WORD_STYLES.workLog, [
        ...summary,
        ...flattenLists(frame.blocks),
      ]);
    case "reasoning":
      return customStyleDiv(SCIENT_WORD_STYLES.reasoning, [...summary, ...frame.blocks]);
    default:
      return div(attr(), [...summary, ...frame.blocks]);
  }
}

function taskBox(item: ReadonlyArray<PandocNode>): "☐" | "☒" | null {
  const first = item[0];
  if (first === undefined) return null;
  const head = inlinesOf(first)?.[0];
  if (head?.t !== "Str" || !Predicate.isString(head.c)) return null;
  if (head.c.startsWith("☐")) return "☐";
  if (head.c.startsWith("☒")) return "☒";
  return null;
}

function taskList(block: PandocNode): PandocNode | null {
  if (block.t !== "BulletList") return null;
  const items = childBlockLists(block);
  if (items.length === 0 || items.some((item) => taskBox(item) === null)) return null;
  const blocks = items.flatMap((item) => {
    const [first, ...rest] = item;
    const inlines = [...(inlinesOf(first!) ?? [])];
    const head = inlines[0]!;
    const box = taskBox(item) === "☒" ? "☑" : "☐";
    const remainder = Predicate.isString(head.c) ? head.c.slice(1) : "";
    inlines.splice(0, 1, ...(remainder.length > 0 ? [str(box + remainder)] : [str(box)]));
    return [para(inlines), ...rest];
  });
  return customStyleDiv(SCIENT_WORD_STYLES.taskList, blocks);
}

function alertDiv(block: PandocNode): PandocNode | null {
  if (block.t !== "Div" || !Array.isArray(block.c)) return null;
  const classes = attrOf(block)?.[1] ?? [];
  if (!classes.some((name) => ALERT_KINDS.has(name))) return null;
  const children = block.c[1] as Array<PandocNode>;
  const [title, ...rest] = children;
  if (title === undefined || title.t !== "Div" || !hasClass(title, "title")) return null;
  const titleInlines = (childBlockLists(title)[0] ?? []).flatMap((child) => inlinesOf(child) ?? []);
  return customStyleDiv(SCIENT_WORD_STYLES.alert, [para([strong(titleInlines)]), ...rest]);
}

/** Proportional widths for wide tables whose columns are all default width. */
function sizeWideTable(table: PandocNode): void {
  const specs = tableColumnSpecs(table);
  if (specs === null || specs.length < WIDE_TABLE_COLUMNS) return;
  if (!specs.every((spec) => spec[1]?.t === "ColWidthDefault")) return;
  const weights = specs.map(() => 4);
  const cellsPerRow = specs.length;
  for (const [index, cell] of tableCells(table).entries()) {
    const column = index % cellsPerRow;
    const longest = Math.max(
      0,
      ...inlineText(cell[4].map((block) => inlinesOf(block) ?? []))
        .split(/\s+/u)
        .map((word) => word.length),
    );
    weights[column] = Math.min(40, Math.max(weights[column] ?? 4, longest));
  }
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  for (const [index, spec] of specs.entries()) {
    spec[1] = { t: "ColWidth", c: (weights[index] ?? 4) / total };
  }
}

export interface StructureInput {
  readonly profile: DocumentMarkdownProfile;
  readonly assets: ReadonlyArray<DocumentAsset>;
}

export interface StructureReport {
  readonly warnings: ReadonlyArray<DocumentWarning>;
  readonly workLogBlocks: number;
  readonly reasoningBlocks: number;
  readonly diagramsRendered: number;
  readonly diagramsMissing: number;
}

/** Applies the Scient structure mapping in place. */
export function applyScientStructure(
  blocks: Array<PandocNode>,
  input: StructureInput,
): StructureReport {
  const diagramAssets = new Set(
    input.assets
      .filter((asset) => asset.role === "rendered-diagram" && asset.content._tag === "bytes")
      .map((asset) => asset.id),
  );
  let exportValue: string | null = null;
  let workLogBlocks = 0;
  let reasoningBlocks = 0;
  let diagramsRendered = 0;
  let diagramsMissing = 0;

  const group = (list: ReadonlyArray<PandocNode>, topLevel: boolean): Array<PandocNode> => {
    const out: Array<PandocNode> = [];
    const stack: Array<DetailsFrame> = [];
    let pendingSpeaker: string | null = null;
    let pendingPart: DetailsKind = null;
    const target = () => stack.at(-1)?.blocks ?? out;
    const emitDetails = (frame: DetailsFrame) => {
      if (frame.kind === "work-log") workLogBlocks += 1;
      if (frame.kind === "reasoning") reasoningBlocks += 1;
      target().push(buildDetails(frame));
    };
    const close = () => {
      emitDetails(stack.pop()!);
    };

    for (const block of list) {
      const html = rawHtml(block);
      if (html !== null) {
        const marker = input.profile === "chat" && topLevel ? parseMarker(html) : null;
        if (marker !== null) {
          const value = marker.fields.get("export") ?? null;
          exportValue ??= marker.kind === "message" ? value : null;
          if (value !== null && value === exportValue) {
            if (marker.kind === "message") {
              const role = marker.fields.get("role");
              pendingSpeaker =
                role === "user"
                  ? SCIENT_WORD_STYLES.speakerUser
                  : role === "assistant"
                    ? SCIENT_WORD_STYLES.speakerAssistant
                    : null;
            } else {
              const kind = marker.fields.get("kind");
              pendingPart = kind === "work-log" || kind === "reasoning" ? kind : null;
            }
          }
          continue;
        }
        const trimmed = html.trim();
        if (DETAILS_OPEN.test(trimmed)) {
          const fragment = parseFragment(trimmed, { sourceCodeLocationInfo: true });
          // Pandoc can put complete and still-open details siblings in one RawBlock.
          // The parser's end-tag location distinguishes them without counting
          // tag-like text in comments, scripts, or styles.
          for (const node of fragment.childNodes) {
            if (isHtmlElement(node, "details")) {
              const frame = detailsFrame(node, pendingPart);
              pendingPart = null;
              if (node.sourceCodeLocation?.endTag !== undefined) {
                emitDetails(frame);
              } else {
                stack.push(frame);
              }
            } else {
              target().push(...visibleHtmlBlocks([node]));
            }
          }
          pendingPart = null;
          continue;
        }
        if (/^<\/details>\s*$/iu.test(trimmed) && stack.length > 0) {
          close();
          continue;
        }
      }
      if (block.t === "Header" && pendingSpeaker !== null) {
        const inlines = inlinesOf(block);
        if (inlines !== null) {
          inlines.splice(0, inlines.length, customStyleSpan(pendingSpeaker, [...inlines]));
        }
      }
      pendingSpeaker = null;
      pendingPart = null;
      target().push(block);
    }
    while (stack.length > 0) close();
    return out;
  };

  const shape = (list: Array<PandocNode>, topLevel: boolean): void => {
    const grouped = group(list, topLevel);
    const shaped: Array<PandocNode> = [];
    for (const block of grouped) {
      if (block.t === "CodeBlock" && hasClass(block, "mermaid") && Array.isArray(block.c)) {
        const source = Predicate.isString(block.c[1]) ? block.c[1] : "";
        const id = mermaidDiagramAssetId(source);
        if (diagramAssets.has(id)) {
          diagramsRendered += 1;
          shaped.push(
            para([
              {
                t: "Image",
                c: [attr(), [str("Diagram")], [`${DOCUMENT_ASSET_URL_PREFIX}${id}`, ""]],
              },
            ]),
          );
        } else {
          diagramsMissing += 1;
          shaped.push(
            para([
              customStyleSpan(
                SCIENT_WORD_STYLES.placeholder,
                textInlines("Mermaid diagram source (image unavailable):"),
              ),
            ]),
            block,
          );
        }
        continue;
      }
      if (block.t === "Table") sizeWideTable(block);
      const replacement = taskList(block) ?? alertDiv(block) ?? block;
      for (const child of childBlockLists(replacement)) shape(child, false);
      // Footnote bodies are block lists inside inlines.
      for (const inline of inlinesOf(replacement) ?? []) {
        if (inline.t === "Note" && Array.isArray(inline.c)) {
          shape(inline.c as Array<PandocNode>, false);
        }
      }
      shaped.push(replacement);
    }
    list.splice(0, list.length, ...shaped);
  };

  shape(blocks, true);

  const warnings: Array<DocumentWarning> = [];
  if (diagramsMissing > 0) {
    warnings.push({
      code: "resource-unresolved",
      message: `${diagramsMissing} Mermaid ${diagramsMissing === 1 ? "diagram has" : "diagrams have"} no rendered image; the complete Mermaid source is included in the Word file.`,
    });
  }
  return { warnings, workLogBlocks, reasoningBlocks, diagramsRendered, diagramsMissing };
}

/** Tables at least this wide are placed on a landscape page. */
const LANDSCAPE_TABLE_COLUMNS = 9;

const sectionBreak = (landscape: boolean, rtl: boolean): PandocNode => ({
  t: "RawBlock",
  c: ["openxml", `<w:p><w:pPr>${sectionPropertiesXml({ landscape, rtl })}</w:pPr></w:p>`],
});

/**
 * Puts each very wide top-level table on its own landscape page. A section
 * break paragraph ends the portrait section before the table and the landscape
 * section after it; adjacent wide tables share one landscape section.
 *
 * This inserts Scient's own OpenXML, so it runs after the security pass, which
 * removes every raw node that came from the document.
 */
export function landscapeWideTables(blocks: Array<PandocNode>, rtl: boolean): number {
  const out: Array<PandocNode> = [];
  let landscaped = 0;
  let inLandscape = false;
  for (const block of blocks) {
    const wide =
      block.t === "Table" && (tableColumnSpecs(block)?.length ?? 0) >= LANDSCAPE_TABLE_COLUMNS;
    if (wide && !inLandscape && out.length > 0) out.push(sectionBreak(false, rtl));
    if (!wide && inLandscape) out.push(sectionBreak(true, rtl));
    inLandscape = wide;
    if (wide) landscaped += 1;
    out.push(block);
  }
  if (inLandscape) out.push(sectionBreak(true, rtl));
  blocks.splice(0, blocks.length, ...out);
  return landscaped;
}

const normalizedText = (text: string) => text.replace(/\s+/gu, " ").trim();

/**
 * The warnings whose text the document does not already show. A conversation
 * bundle lists its notes in its Markdown; other bundles may not, and their
 * notes must still reach the Word file.
 */
export function unlistedWarnings(
  blocks: ReadonlyArray<PandocNode>,
  warnings: ReadonlyArray<DocumentWarning>,
): Array<DocumentWarning> {
  const shown = normalizedText(inlineText(blocks));
  return warnings.filter((warning) => !shown.includes(normalizedText(warning.message)));
}

/** A closing "Conversion notes" section listing what this Word export could not carry. */
export function conversionNotesBlocks(warnings: ReadonlyArray<DocumentWarning>): Array<PandocNode> {
  if (warnings.length === 0) return [];
  return [
    para([strong([str("Conversion"), space(), str("notes")])]),
    {
      t: "BulletList",
      c: warnings.map((warning) => [{ t: "Plain", c: textInlines(warning.message) }]),
    },
  ];
}
