import MarkdownIt from "markdown-it";
import {
  defaultMarkdownParser,
  defaultMarkdownSerializer,
  MarkdownParser,
  MarkdownSerializer,
  type MarkdownSerializerState,
} from "prosemirror-markdown";
import type {
  DOMOutputSpec,
  MarkSpec,
  Node as ProseMirrorNode,
  NodeSpec,
  SchemaSpec,
} from "prosemirror-model";
import { Schema } from "prosemirror-model";
import { tableNodes } from "prosemirror-tables";

import { isPlausibleScientSingleDollarTex } from "~/scient/math/scientSingleDollarMath";
import {
  parsedReferenceAttributes,
  preserveMarkdownReferences,
  referenceAttributes,
  retainedReferenceLabel,
} from "./referenceLinks";

const SOURCE_ID_ATTR = { default: null } as const;
const SOURCE_COPY_ID_ATTR = { default: null } as const;
const TOP_LEVEL_SOURCE_NODE_NAMES = [
  "paragraph",
  "blockquote",
  "horizontal_rule",
  "heading",
  "code_block",
  "ordered_list",
  "bullet_list",
  "table",
  "display_math",
  "footnote_definition",
  "raw_block",
] as const;

const inlineMathSpec: NodeSpec = {
  attrs: { tex: { default: "" }, delimiter: { default: "$" } },
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  parseDOM: [
    {
      tag: "span[data-scient-markdown-inline-math]",
      getAttrs: (element) => ({ tex: element.getAttribute("data-tex") ?? "" }),
    },
  ],
  toDOM: (node) => [
    "span",
    {
      "data-scient-markdown-inline-math": "true",
      "data-tex": String(node.attrs.tex),
    },
    `$${String(node.attrs.tex)}$`,
  ],
};

const wikiLinkSpec: NodeSpec = {
  attrs: {
    target: { default: "" },
    label: { default: null },
  },
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  leafText: (node) => String(node.attrs.label ?? node.attrs.target),
  parseDOM: [
    {
      tag: "span[data-scient-markdown-wiki-link]",
      getAttrs: (element) => ({
        target: element.getAttribute("data-target") ?? "",
        label: element.getAttribute("data-label"),
      }),
    },
  ],
  toDOM: (node) => [
    "span",
    {
      "data-scient-markdown-wiki-link": "true",
      "data-target": String(node.attrs.target),
      "data-label": typeof node.attrs.label === "string" ? node.attrs.label : null,
    },
    String(node.attrs.label ?? node.attrs.target),
  ],
};

const citationSpec: NodeSpec = {
  attrs: { source: { default: "@citation" } },
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  leafText: (node) => `[${String(node.attrs.source)}]`,
  parseDOM: [
    {
      tag: "span[data-scient-markdown-citation]",
      getAttrs: (element) => ({ source: element.getAttribute("data-source") ?? "@citation" }),
    },
  ],
  toDOM: (node) => [
    "span",
    { "data-scient-markdown-citation": "true", "data-source": String(node.attrs.source) },
    `[${String(node.attrs.source)}]`,
  ],
};

const footnoteReferenceSpec: NodeSpec = {
  attrs: { label: { default: "note" } },
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  leafText: (node) => `[^${String(node.attrs.label)}]`,
  parseDOM: [
    {
      tag: "sup[data-scient-markdown-footnote-reference]",
      getAttrs: (element) => ({ label: element.getAttribute("data-label") ?? "note" }),
    },
  ],
  toDOM: (node) => [
    "sup",
    {
      "data-scient-markdown-footnote-reference": "true",
      "data-label": String(node.attrs.label),
    },
    String(node.attrs.label),
  ],
};

const footnoteDefinitionSpec: NodeSpec = {
  attrs: {
    label: { default: "note" },
    source: { default: "[^note]: " },
    sourceId: SOURCE_ID_ATTR,
  },
  group: "block",
  atom: true,
  defining: true,
  selectable: true,
  parseDOM: [
    {
      tag: "aside[data-scient-markdown-footnote-definition]",
      getAttrs: (element) => ({
        label: element.getAttribute("data-label") ?? "note",
        source: element.getAttribute("data-source") ?? element.textContent ?? "",
      }),
    },
  ],
  toDOM: (node) => [
    "aside",
    {
      "data-scient-markdown-footnote-definition": "true",
      "data-label": String(node.attrs.label),
      "data-source": String(node.attrs.source),
    },
    String(node.attrs.source),
  ],
};

const strikeSpec: MarkSpec = {
  parseDOM: [{ tag: "s" }, { tag: "del" }, { tag: "strike" }],
  toDOM: () => ["s", 0],
};

const displayMathSpec: NodeSpec = {
  attrs: {
    tex: { default: "" },
    delimiter: { default: "$$" },
    sourceId: SOURCE_ID_ATTR,
  },
  group: "block",
  atom: true,
  selectable: true,
  defining: true,
  parseDOM: [
    {
      tag: "div[data-scient-markdown-display-math]",
      getAttrs: (element) => ({ tex: element.getAttribute("data-tex") ?? "" }),
    },
  ],
  toDOM: (node) => [
    "div",
    {
      "data-scient-markdown-display-math": "true",
      "data-tex": String(node.attrs.tex),
    },
    `$$\n${String(node.attrs.tex)}\n$$`,
  ],
};

const rawBlockSpec: NodeSpec = {
  attrs: {
    source: { default: "" },
    sourceId: SOURCE_ID_ATTR,
    sourceKind: { default: "unknown" },
  },
  group: "block",
  atom: true,
  selectable: true,
  defining: true,
  parseDOM: [
    {
      tag: "pre[data-scient-markdown-raw]",
      getAttrs: (element) => ({
        source: element.textContent ?? "",
        sourceKind: element.getAttribute("data-scient-markdown-kind") ?? "unknown",
      }),
    },
  ],
  toDOM: (node) => [
    "pre",
    {
      "data-scient-markdown-kind": String(node.attrs.sourceKind),
      "data-scient-markdown-raw": "true",
    },
    ["code", String(node.attrs.source)],
  ],
  toDebugString: (node) => `raw_block(${JSON.stringify(node.attrs.sourceKind)})`,
};

let nodes = defaultMarkdownParser.schema.spec.nodes.addBefore(
  "image",
  "inline_math",
  inlineMathSpec,
);
nodes = nodes.addBefore("image", "wiki_link", wikiLinkSpec);
nodes = nodes.addBefore("image", "citation", citationSpec);
nodes = nodes.addBefore("image", "footnote_reference", footnoteReferenceSpec);
nodes = nodes.addBefore("image", "display_math", displayMathSpec);
nodes = nodes.addBefore("image", "footnote_definition", footnoteDefinitionSpec);
nodes = nodes.addBefore("image", "raw_block", rawBlockSpec);
const imageSpec = nodes.get("image");
if (!imageSpec) throw new Error("Missing ProseMirror node spec 'image'.");
nodes = nodes.update("image", {
  ...imageSpec,
  attrs: { ...imageSpec.attrs, ...referenceAttributes },
});
const listItemSpec = nodes.get("list_item");
if (!listItemSpec) throw new Error("Missing ProseMirror node spec 'list_item'.");
nodes = nodes.update("list_item", {
  ...listItemSpec,
  attrs: { ...listItemSpec.attrs, taskChecked: { default: null } },
  parseDOM: [
    {
      tag: "li",
      getAttrs: (element) => {
        const checked = element.getAttribute("data-task-checked");
        return { taskChecked: checked === null ? null : checked === "true" };
      },
    },
  ],
  toDOM: (node) => [
    "li",
    {
      "data-task-checked":
        typeof node.attrs.taskChecked === "boolean" ? String(node.attrs.taskChecked) : null,
    },
    0,
  ],
});
const bulletListSpec = nodes.get("bullet_list");
if (!bulletListSpec) throw new Error("Missing ProseMirror node spec 'bullet_list'.");
nodes = nodes.update("bullet_list", {
  ...bulletListSpec,
  attrs: { ...bulletListSpec.attrs, bullet: { default: "*" } },
});
nodes = nodes.append(
  tableNodes({
    tableGroup: "block",
    cellContent: "inline*",
    cellAttributes: {
      alignment: {
        default: null,
        getFromDOM: (element) => element.getAttribute("data-alignment"),
        setDOMAttr: (value, attrs) => {
          if (typeof value === "string" && value.length > 0) attrs["data-alignment"] = value;
        },
      },
    },
  }),
);
const tableRowSpec = nodes.get("table_row");
if (!tableRowSpec) throw new Error("Missing ProseMirror node spec 'table_row'.");
// Inline cells are textblocks, which otherwise makes gapCursor treat the
// spaces between cells as places to type. A caret belongs inside a cell or
// outside the table, never directly in a row.
nodes = nodes.update("table_row", { ...tableRowSpec, allowGapCursor: false });
for (const name of TOP_LEVEL_SOURCE_NODE_NAMES) {
  const spec = nodes.get(name);
  if (!spec) throw new Error(`Missing ProseMirror node spec '${name}'.`);
  nodes = nodes.update(name, {
    ...spec,
    attrs: {
      ...spec.attrs,
      sourceId: SOURCE_ID_ATTR,
      sourceCopyId: SOURCE_COPY_ID_ATTR,
    },
  });
}

// Direction belongs to a block. Tables share the existing wrapper convention;
// individual GFM cells do not acquire unpersistable direction attributes.
function withTextDirectionAttrs(
  name: "paragraph" | "heading" | "table",
  extraAttrs: (element: HTMLElement) => Record<string, unknown>,
): void {
  const spec = nodes.get(name);
  if (!spec) throw new Error(`Missing ProseMirror node spec '${name}'.`);
  nodes = nodes.update(name, {
    ...spec,
    attrs: { ...spec.attrs, dir: { default: null } },
    parseDOM: (spec.parseDOM ?? []).map((rule) => ({
      ...rule,
      getAttrs: (element: HTMLElement) => ({
        ...rule.getAttrs?.(element),
        ...extraAttrs(element),
        dir: ["ltr", "rtl"].includes(element.getAttribute("dir") ?? "")
          ? element.getAttribute("dir")
          : null,
      }),
    })),
    toDOM: (node) => {
      const dom: DOMOutputSpec = spec.toDOM ? spec.toDOM(node) : [name, 0];
      if (typeof node.attrs.dir !== "string") return dom;
      if (!Array.isArray(dom) || typeof dom[0] !== "string") return dom;

      const [tag, second, ...rest] = dom;
      const secondIsAttrs =
        second === null ||
        (typeof second === "object" &&
          second !== null &&
          !Array.isArray(second) &&
          !("nodeType" in second) &&
          !("dom" in second));
      if (secondIsAttrs) {
        return [tag, { ...second, dir: node.attrs.dir }, ...rest] as DOMOutputSpec;
      }

      // A node spec such as ["p", 0] has no attributes object; its second
      // item is the content hole. Insert attributes before it and preserve the
      // hole so changing direction cannot hide the node's text.
      return [
        tag,
        { dir: node.attrs.dir },
        ...(second === undefined ? [] : [second]),
        ...rest,
      ] as DOMOutputSpec;
    },
  });
}

withTextDirectionAttrs("paragraph", () => ({}));
withTextDirectionAttrs("heading", (element) => ({
  level: Number(element.tagName.slice(1)),
}));
withTextDirectionAttrs("table", () => ({}));

const linkSpec = defaultMarkdownParser.schema.spec.marks.get("link");
if (!linkSpec) throw new Error("Missing ProseMirror mark spec 'link'.");
export const scientMarkdownSchema: Schema = new Schema({
  nodes,
  marks: defaultMarkdownParser.schema.spec.marks
    .update("link", { ...linkSpec, attrs: { ...linkSpec.attrs, ...referenceAttributes } })
    .addToEnd("strike", strikeSpec),
} satisfies SchemaSpec);

function tableAlignment(token: { readonly attrGet: (name: string) => string | null }): {
  readonly alignment: string | null;
} {
  const style = token.attrGet("style") ?? "";
  const match = /(?:^|;)\s*text-align\s*:\s*(left|center|right)\s*(?:;|$)/iu.exec(style);
  return { alignment: match?.[1]?.toLowerCase() ?? null };
}

function listIsTight(
  tokens: ReadonlyArray<{ readonly type: string; readonly hidden: boolean }>,
  index: number,
) {
  for (let cursor = index + 1; cursor < tokens.length; cursor += 1) {
    const token = tokens[cursor];
    if (token?.type !== "list_item_open") return token?.hidden ?? false;
  }
  return false;
}

const gfmTokenizer = MarkdownIt("commonmark", { html: false }).enable(["strikethrough", "table"]);
preserveMarkdownReferences(gfmTokenizer);

// Recognize only this inert Markdown line-break form, not arbitrary HTML.
gfmTokenizer.inline.ruler.before("html_inline", "scient_hard_break", (state, silent) => {
  const match = /^<br\s*\/?\s*>/iu.exec(state.src.slice(state.pos));
  if (!match) return false;
  if (!silent) state.push("hardbreak", "br", 0);
  state.pos += match[0].length;
  return true;
});

gfmTokenizer.inline.ruler.before("link", "scient_footnote_reference", (state, silent) => {
  const start = state.pos;
  if (state.src.slice(start, start + 2) !== "[^") return false;
  const end = state.src.indexOf("]", start + 2);
  if (end < 0) return false;
  const label = state.src.slice(start + 2, end).trim();
  if (label.length === 0 || /\s/u.test(label) || label.includes("[") || label.includes("]")) {
    return false;
  }
  if (!silent) {
    const token = state.push("scient_footnote_reference", "sup", 0);
    token.meta = { label };
  }
  state.pos = end + 1;
  return true;
});

gfmTokenizer.inline.ruler.before("link", "scient_citation", (state, silent) => {
  const start = state.pos;
  if (state.src[start] !== "[") return false;
  const end = state.src.indexOf("]", start + 1);
  if (end < 0) return false;
  // Let ordinary inline/reference links containing citation-like text reach
  // Markdown's link tokenizer instead of consuming only their label.
  if (state.src[end + 1] === "(" || state.src[end + 1] === "[") return false;
  const source = state.src.slice(start + 1, end).trim();
  if (!/(?:^|[;\s])-?@[\p{L}\p{N}_:.#-]+/u.test(source)) return false;
  if (!silent) {
    const token = state.push("scient_citation", "span", 0);
    token.meta = { source };
  }
  state.pos = end + 1;
  return true;
});

gfmTokenizer.inline.ruler.before("link", "scient_wiki_link", (state, silent) => {
  const start = state.pos;
  if (state.src.slice(start, start + 2) !== "[[") return false;
  const end = state.src.indexOf("]]", start + 2);
  if (end < 0) return false;
  const inner = state.src.slice(start + 2, end).trim();
  if (inner.length === 0 || inner.includes("\n")) return false;
  const separator = inner.indexOf("|");
  const target = (separator < 0 ? inner : inner.slice(0, separator)).trim();
  const label = separator < 0 ? null : inner.slice(separator + 1).trim();
  if (target.length === 0 || label === "") return false;
  if (!silent) {
    const token = state.push("scient_wiki_link", "span", 0);
    token.meta = { label, target };
  }
  state.pos = end + 2;
  return true;
});

gfmTokenizer.inline.ruler.after("escape", "scient_inline_math", (state, silent) => {
  const start = state.pos;
  if (state.src[start] !== "$" || state.src[start + 1] === "$") return false;
  const previous = start > 0 ? state.src[start - 1] : "";
  if (previous && /[\p{L}\p{N}$]/u.test(previous)) return false;
  let end = start + 1;
  while (end < state.posMax) {
    if (state.src[end] === "$" && state.src[end - 1] !== "\\") break;
    end += 1;
  }
  if (end >= state.posMax) return false;
  const tex = state.src.slice(start + 1, end);
  if (!isPlausibleScientSingleDollarTex(tex)) return false;
  if (!silent) {
    const token = state.push("scient_inline_math", "math", 0);
    token.content = tex;
  }
  state.pos = end + 1;
  return true;
});

gfmTokenizer.core.ruler.after("inline", "scient_task_lists", (state) => {
  for (let index = 0; index < state.tokens.length; index += 1) {
    const listItem = state.tokens[index];
    if (listItem?.type !== "list_item_open") continue;
    const itemEnd = state.tokens.findIndex(
      (token, tokenIndex) => tokenIndex > index && token.type === "list_item_close",
    );
    const inline = state.tokens
      .slice(index + 1, itemEnd < 0 ? undefined : itemEnd)
      .find((token) => token.type === "inline");
    if (!inline) continue;
    const match = /^\[([ xX])\](?:\s+|$)/u.exec(inline.content);
    const firstChild = inline?.children?.[0];
    if (!match || firstChild?.type !== "text" || !firstChild.content.startsWith(match[0])) {
      continue;
    }
    listItem.meta = { ...listItem.meta, scientTaskChecked: match[1]?.toLowerCase() === "x" };
    inline.content = inline.content.slice(match[0].length);
    firstChild.content = firstChild.content.slice(match[0].length);
  }
});

// Text-direction convention: the only interoperable Markdown form is the HTML
// wrapper the serializer emits (`<div dir="rtl">` ... `</div>` blocks). The
// tokenizer keeps HTML disabled, so these lines arrive as literal paragraph
// text and are rewritten here into attributes on the enclosed blocks.
gfmTokenizer.core.ruler.after("scient_task_lists", "scient_direction_divs", (state) => {
  let pendingDir: string | null = null;
  const kept: typeof state.tokens = [];
  for (let index = 0; index < state.tokens.length; index += 1) {
    const token = state.tokens[index];
    if (!token) continue;
    const inline = state.tokens[index + 1];
    if (token.type === "paragraph_open" && inline?.type === "inline") {
      const content = inline.content.trim();
      const openMatch = /^<div dir="(ltr|rtl|auto)">$/u.exec(content);
      if (openMatch) {
        pendingDir = openMatch[1] === "auto" || openMatch[1] === undefined ? null : openMatch[1];
        index += 2;
        continue;
      }
      if (/^<\/div>$/u.test(content)) {
        pendingDir = null;
        index += 2;
        continue;
      }
    }
    if (
      pendingDir !== null &&
      (token.type === "paragraph_open" ||
        token.type === "heading_open" ||
        token.type === "table_open")
    ) {
      token.attrSet("data-scient-dir", pendingDir);
    }
    kept.push(token);
  }
  state.tokens = kept;
});

export const scientMarkdownParser = new MarkdownParser(scientMarkdownSchema, gfmTokenizer, {
  ...defaultMarkdownParser.tokens,
  link: {
    mark: "link",
    getAttrs: (token) => ({
      href: token.attrGet("href"),
      title: token.attrGet("title") || null,
      ...parsedReferenceAttributes(token, "href"),
    }),
  },
  image: {
    node: "image",
    getAttrs: (token) => ({
      src: token.attrGet("src"),
      title: token.attrGet("title") || null,
      alt: token.children?.[0]?.content || null,
      ...parsedReferenceAttributes(token, "src"),
    }),
  },
  paragraph: {
    block: "paragraph",
    getAttrs: (token) => ({ dir: token.attrGet("data-scient-dir") }),
  },
  heading: {
    block: "heading",
    getAttrs: (token) => ({
      level: Number(token.tag.slice(1)),
      dir: token.attrGet("data-scient-dir"),
    }),
  },
  table: { block: "table", getAttrs: (token) => ({ dir: token.attrGet("data-scient-dir") }) },
  thead: { ignore: true },
  tbody: { ignore: true },
  tr: { block: "table_row" },
  th: { block: "table_header", getAttrs: tableAlignment },
  td: { block: "table_cell", getAttrs: tableAlignment },
  bullet_list: {
    block: "bullet_list",
    getAttrs: (token, tokens, index) => ({
      bullet: token.markup || "*",
      tight: listIsTight(tokens, index),
    }),
  },
  list_item: {
    block: "list_item",
    getAttrs: (token) => ({
      taskChecked:
        typeof token.meta?.scientTaskChecked === "boolean" ? token.meta.scientTaskChecked : null,
    }),
  },
  s: { mark: "strike" },
  scient_inline_math: {
    node: "inline_math",
    getAttrs: (token) => ({ tex: token.content, delimiter: "$" }),
  },
  scient_wiki_link: {
    node: "wiki_link",
    getAttrs: (token) => token.meta,
  },
  scient_citation: {
    node: "citation",
    getAttrs: (token) => token.meta,
  },
  scient_footnote_reference: {
    node: "footnote_reference",
    getAttrs: (token) => token.meta,
  },
});

function tableCellMarkdown(cell: ProseMirrorNode): string {
  const paragraphType = scientMarkdownSchema.nodes.paragraph;
  if (!paragraphType) throw new Error("Scient Markdown schema is missing paragraph.");
  const paragraph = paragraphType.create(null, cell.content);
  const document = scientMarkdownSchema.topNodeType.createAndFill(null, [paragraph]);
  if (!document) throw new Error("Unable to serialize a Markdown table cell.");
  return tableCellSerializer
    .serialize(document)
    .replace(
      /(\\*)\|/gu,
      (_match, escapes: string) => `${escapes}${escapes.length % 2 === 0 ? "\\" : ""}|`,
    )
    .replace(/^ +| +$/gu, (spaces) => "&#32;".repeat(spaces.length));
}

function tableDelimiter(alignment: unknown): string {
  switch (alignment) {
    case "left":
      return ":---";
    case "center":
      return ":---:";
    case "right":
      return "---:";
    default:
      return "---";
  }
}

function tableMarkdown(table: ProseMirrorNode): string {
  const rows: string[] = [];
  table.forEach((row, _rowOffset, rowIndex) => {
    const cells: string[] = [];
    const delimiters: string[] = [];
    row.forEach((cell) => {
      cells.push(tableCellMarkdown(cell));
      delimiters.push(tableDelimiter(cell.attrs.alignment));
    });
    rows.push(`| ${cells.join(" | ")} |`);
    if (rowIndex === 0) rows.push(`| ${delimiters.join(" | ")} |`);
  });
  return rows.join("\n");
}

function blockWithDirection(
  state: MarkdownSerializerState,
  node: ProseMirrorNode,
  render: () => void,
): void {
  const dir = node.attrs.dir;
  if (typeof dir !== "string") {
    render();
    return;
  }
  state.write(`<div dir="${dir}">`);
  state.closeBlock(node);
  render();
  state.closeBlock(node);
  state.write("</div>");
  state.closeBlock(node);
}

export const scientMarkdownSerializer = new MarkdownSerializer(
  {
    ...defaultMarkdownSerializer.nodes,
    image: (state, node, parent, index) => {
      const label = retainedReferenceLabel(node.attrs, "src");
      if (label === null) defaultMarkdownSerializer.nodes.image?.(state, node, parent, index);
      else state.write(`![${state.esc(node.attrs.alt || "")}][${label}]`);
    },
    paragraph: (state, node, parent, index) => {
      blockWithDirection(state, node, () => {
        defaultMarkdownSerializer.nodes.paragraph?.(state, node, parent, index);
      });
    },
    heading: (state, node, parent, index) => {
      blockWithDirection(state, node, () => {
        defaultMarkdownSerializer.nodes.heading?.(state, node, parent, index);
      });
    },
    raw_block: (state, node) => state.write(String(node.attrs.source)),
    wiki_link: (state, node) => {
      const target = String(node.attrs.target);
      const label = typeof node.attrs.label === "string" ? `|${node.attrs.label}` : "";
      state.write(`[[${target}${label}]]`);
    },
    citation: (state, node) => state.write(`[${String(node.attrs.source)}]`),
    footnote_reference: (state, node) => state.write(`[^${String(node.attrs.label)}]`),
    footnote_definition: (state, node) => {
      state.write(String(node.attrs.source));
      state.closeBlock(node);
    },
    inline_math: (state, node) => state.text(`$${String(node.attrs.tex)}$`, false),
    display_math: (state, node) => {
      state.write(`$$\n${String(node.attrs.tex)}\n$$`);
      state.closeBlock(node);
    },
    table: (state, node) => {
      blockWithDirection(state, node, () => {
        // Prefix every row with the surrounding list/quote delimiter.
        state.text(tableMarkdown(node), false);
        state.closeBlock(node);
      });
    },
    // These are consumed by the table serializer and cannot be reached as
    // standalone document blocks, but strict mode requires named handlers.
    list_item: (state, node) => {
      if (typeof node.attrs.taskChecked === "boolean") {
        state.write(node.attrs.taskChecked ? "[x] " : "[ ] ");
      }
      state.renderContent(node);
    },
    table_row: () => undefined,
    table_cell: () => undefined,
    table_header: () => undefined,
  },
  {
    ...defaultMarkdownSerializer.marks,
    link: {
      mixable: true,
      open: (state, mark, parent, index) => {
        if (retainedReferenceLabel(mark.attrs, "href") !== null) {
          return "[";
        }
        const open = defaultMarkdownSerializer.marks.link!.open;
        return typeof open === "string" ? open : open(state, mark, parent, index);
      },
      close: (state, mark, parent, index) => {
        const label = retainedReferenceLabel(mark.attrs, "href");
        if (label !== null) {
          return `][${label}]`;
        }
        const close = defaultMarkdownSerializer.marks.link!.close;
        return typeof close === "string" ? close : close(state, mark, parent, index);
      },
    },
    strike: {
      close: "~~",
      expelEnclosingWhitespace: true,
      mixable: true,
      open: "~~",
    },
  },
  { escapeExtraCharacters: /[<&]/gu },
);

const tableCellSerializer = new MarkdownSerializer(
  {
    ...scientMarkdownSerializer.nodes,
    hard_break: (state) => state.write("<br>"),
  },
  scientMarkdownSerializer.marks,
  { escapeExtraCharacters: /[<&]/gu },
);

export function withMarkdownSourceId(node: ProseMirrorNode, sourceId: string): ProseMirrorNode {
  return node.type.create({ ...node.attrs, sourceId }, node.content, node.marks);
}
