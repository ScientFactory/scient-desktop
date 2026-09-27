/**
 * Just enough of Pandoc's JSON document model (pandoc-types 1.23) for Scient
 * to shape and secure a document between Pandoc's read and write passes.
 *
 * Nodes are `{ t, c }` objects. Scient only builds and rewrites the node kinds
 * it understands; everything else passes through untouched, and the security
 * pass walks the tree generically so an unknown node kind cannot hide a raw
 * block or an image from it.
 */
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

export interface PandocNode {
  t: string;
  c?: unknown;
}

/** `[identifier, classes, key-value pairs]`. */
export type PandocAttr = [string, Array<string>, Array<[string, string]>];

export interface PandocDocument {
  "pandoc-api-version": Array<number>;
  meta: Record<string, PandocNode>;
  blocks: Array<PandocNode>;
}

const PandocDocumentJson = Schema.fromJsonString(
  Schema.Struct({
    "pandoc-api-version": Schema.Array(Schema.Number),
    meta: Schema.Record(Schema.String, Schema.Unknown),
    blocks: Schema.Array(Schema.Unknown),
  }),
);

export const decodePandocDocument = Schema.decodeUnknownEffect(PandocDocumentJson);

export function isPandocNode(value: unknown): value is PandocNode {
  return Predicate.isObject(value) && Predicate.isString((value as { t?: unknown }).t);
}

/** Narrows the decoded top level into the mutable tree the passes rewrite. */
export function toPandocDocument(decoded: {
  readonly "pandoc-api-version": ReadonlyArray<number>;
  readonly meta: Readonly<Record<string, unknown>>;
  readonly blocks: ReadonlyArray<unknown>;
}): PandocDocument {
  const meta: Record<string, PandocNode> = {};
  for (const [key, value] of Object.entries(decoded.meta)) {
    if (isPandocNode(value)) meta[key] = value;
  }
  return {
    "pandoc-api-version": [...decoded["pandoc-api-version"]],
    meta,
    blocks: decoded.blocks.filter(isPandocNode),
  };
}

export const attr = (
  classes: ReadonlyArray<string> = [],
  pairs: ReadonlyArray<readonly [string, string]> = [],
): PandocAttr => ["", [...classes], pairs.map(([key, value]) => [key, value])];

export const str = (text: string): PandocNode => ({ t: "Str", c: text });
export const space = (): PandocNode => ({ t: "Space" });
export const para = (inlines: Array<PandocNode>): PandocNode => ({ t: "Para", c: inlines });
export const strong = (inlines: Array<PandocNode>): PandocNode => ({ t: "Strong", c: inlines });
export const div = (attributes: PandocAttr, blocks: Array<PandocNode>): PandocNode => ({
  t: "Div",
  c: [attributes, blocks],
});
export const span = (attributes: PandocAttr, inlines: Array<PandocNode>): PandocNode => ({
  t: "Span",
  c: [attributes, inlines],
});
export const bulletList = (items: Array<Array<PandocNode>>): PandocNode => ({
  t: "BulletList",
  c: items,
});
export const customStyleDiv = (style: string, blocks: Array<PandocNode>) =>
  div(attr([], [["custom-style", style]]), blocks);
export const customStyleSpan = (style: string, inlines: Array<PandocNode>) =>
  span(attr([], [["custom-style", style]]), inlines);

/** Words as `Str` nodes separated by `Space`, the way Pandoc's readers emit text. */
export function textInlines(text: string): Array<PandocNode> {
  const out: Array<PandocNode> = [];
  for (const [index, word] of text
    .split(/\s+/u)
    .filter((part) => part.length > 0)
    .entries()) {
    if (index > 0) out.push(space());
    out.push(str(word));
  }
  if (/^\s/u.test(text) && out.length > 0) out.unshift(space());
  if (/\s$/u.test(text) && out.length > 0) out.push(space());
  return out;
}

/** The plain text of inlines, as a reader would see it; math, code, and notes are skipped. */
export function inlineText(value: unknown): string {
  let text = "";
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }
    if (!isPandocNode(node)) return;
    switch (node.t) {
      case "Str":
        text += Predicate.isString(node.c) ? node.c : "";
        return;
      case "Space":
      case "SoftBreak":
      case "LineBreak":
        text += " ";
        return;
      case "Math":
      case "Code":
      case "Note":
      case "RawInline":
        return;
      case "Link":
      case "Image":
      case "Span":
        if (Array.isArray(node.c)) walk(node.c[1]);
        return;
      case "Quoted":
      case "Cite":
        if (Array.isArray(node.c)) walk(node.c[1]);
        return;
      default:
        walk(node.c);
    }
  };
  walk(value);
  return text;
}

export function attrOf(node: PandocNode): PandocAttr | null {
  if (!Array.isArray(node.c)) return null;
  const candidate: unknown = node.t === "Header" ? node.c[1] : node.c[0];
  if (
    Array.isArray(candidate) &&
    candidate.length === 3 &&
    Predicate.isString(candidate[0]) &&
    Array.isArray(candidate[1]) &&
    Array.isArray(candidate[2])
  ) {
    return candidate as PandocAttr;
  }
  return null;
}

export function hasClass(node: PandocNode, className: string): boolean {
  return attrOf(node)?.[1].includes(className) ?? false;
}

export function attrValue(node: PandocNode, key: string): string | null {
  return attrOf(node)?.[2].find(([name]) => name === key)?.[1] ?? null;
}

/** The inline list of a `Para`, `Plain`, or `Header`; null for anything else. */
export function inlinesOf(node: PandocNode): Array<PandocNode> | null {
  if ((node.t === "Para" || node.t === "Plain") && Array.isArray(node.c)) {
    return node.c as Array<PandocNode>;
  }
  if (node.t === "Header" && Array.isArray(node.c) && Array.isArray(node.c[2])) {
    return node.c[2] as Array<PandocNode>;
  }
  return null;
}

/**
 * Every nested block list of a block, in document order: list items, quote
 * and div contents, figure bodies, and table cells. Rewriting a returned list
 * in place rewrites the document.
 */
export function childBlockLists(node: PandocNode): Array<Array<PandocNode>> {
  const c = node.c;
  if (!Array.isArray(c)) return [];
  switch (node.t) {
    case "BlockQuote":
      return [c as Array<PandocNode>];
    case "BulletList":
      return c as Array<Array<PandocNode>>;
    case "OrderedList":
      return Array.isArray(c[1]) ? (c[1] as Array<Array<PandocNode>>) : [];
    case "DefinitionList":
      return (c as Array<[unknown, Array<Array<PandocNode>>]>).flatMap((entry) =>
        Array.isArray(entry[1]) ? entry[1] : [],
      );
    case "Div":
      return Array.isArray(c[1]) ? [c[1] as Array<PandocNode>] : [];
    case "Figure":
      return Array.isArray(c[2]) ? [c[2] as Array<PandocNode>] : [];
    case "Table":
      return tableCells(node).map((cell) => cell[4]);
    default:
      return [];
  }
}

type TableCell = [PandocAttr, unknown, number, number, Array<PandocNode>];
type TableRow = [PandocAttr, Array<TableCell>];

/** Cells of a table's head, bodies (head rows and body rows), and foot. */
export function tableCells(table: PandocNode): Array<TableCell> {
  if (table.t !== "Table" || !Array.isArray(table.c)) return [];
  const [, , , head, bodies, foot] = table.c as [
    unknown,
    unknown,
    unknown,
    [PandocAttr, Array<TableRow>],
    Array<[PandocAttr, number, Array<TableRow>, Array<TableRow>]>,
    [PandocAttr, Array<TableRow>],
  ];
  const rows: Array<TableRow> = [
    ...(head?.[1] ?? []),
    ...(bodies ?? []).flatMap((body) => [...(body[2] ?? []), ...(body[3] ?? [])]),
    ...(foot?.[1] ?? []),
  ];
  return rows.flatMap((row) => row[1] ?? []);
}

/** Number of columns and the column specs of a table. */
export function tableColumnSpecs(table: PandocNode): Array<[PandocNode, PandocNode]> | null {
  if (table.t !== "Table" || !Array.isArray(table.c) || !Array.isArray(table.c[2])) return null;
  return table.c[2] as Array<[PandocNode, PandocNode]>;
}

/** Applies `visit` to every inline list in the blocks, including table cells and footnotes. */
export function forEachInlineList(
  blocks: Array<PandocNode>,
  visit: (inlines: Array<PandocNode>) => void,
): void {
  const visitInlines = (inlines: Array<PandocNode>) => {
    visit(inlines);
    for (const inline of inlines) {
      const c = inline.c;
      if (!Array.isArray(c)) continue;
      switch (inline.t) {
        case "Emph":
        case "Underline":
        case "Strong":
        case "Strikeout":
        case "Superscript":
        case "Subscript":
        case "SmallCaps":
          visitInlines(c as Array<PandocNode>);
          break;
        case "Quoted":
        case "Span":
        case "Link":
          if (Array.isArray(c[1])) visitInlines(c[1] as Array<PandocNode>);
          break;
        case "Note":
          visitBlocks(c as Array<PandocNode>);
          break;
      }
    }
  };
  const visitBlocks = (list: Array<PandocNode>) => {
    for (const block of list) {
      const inlines = inlinesOf(block);
      if (inlines !== null) visitInlines(inlines);
      if (block.t === "LineBlock" && Array.isArray(block.c)) {
        for (const line of block.c as Array<Array<PandocNode>>) visitInlines(line);
      }
      for (const child of childBlockLists(block)) visitBlocks(child);
    }
  };
  visitBlocks(blocks);
}
