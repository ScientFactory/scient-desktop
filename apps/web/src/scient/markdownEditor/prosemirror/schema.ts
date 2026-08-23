import MarkdownIt from "markdown-it";
import {
  defaultMarkdownParser,
  defaultMarkdownSerializer,
  MarkdownParser,
  MarkdownSerializer,
} from "prosemirror-markdown";
import type { MarkSpec, Node as ProseMirrorNode, NodeSpec, SchemaSpec } from "prosemirror-model";
import { Schema } from "prosemirror-model";
import { tableNodes } from "prosemirror-tables";

import { isPlausibleScientSingleDollarTex } from "~/scient/math/scientSingleDollarMath";

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

export const scientMarkdownSchema: Schema = new Schema({
  nodes,
  marks: defaultMarkdownParser.schema.spec.marks.addToEnd("strike", strikeSpec),
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

export const scientMarkdownParser = new MarkdownParser(scientMarkdownSchema, gfmTokenizer, {
  ...defaultMarkdownParser.tokens,
  table: { block: "table" },
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
  return scientMarkdownSerializer
    .serialize(document)
    .replace(/\r?\n/gu, "<br>")
    .replace(/(?<!\\)\|/gu, "\\|")
    .trim();
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

export const scientMarkdownSerializer = new MarkdownSerializer(
  {
    ...defaultMarkdownSerializer.nodes,
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
      state.write(tableMarkdown(node));
      state.closeBlock(node);
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
    strike: {
      close: "~~",
      expelEnclosingWhitespace: true,
      mixable: true,
      open: "~~",
    },
  },
);

export function withMarkdownSourceId(node: ProseMirrorNode, sourceId: string): ProseMirrorNode {
  return node.type.create({ ...node.attrs, sourceId }, node.content, node.marks);
}
