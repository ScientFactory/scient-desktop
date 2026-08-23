import MarkdownIt from "markdown-it";
import {
  defaultMarkdownParser,
  defaultMarkdownSerializer,
  MarkdownParser,
  MarkdownSerializer,
} from "prosemirror-markdown";
import type { Node as ProseMirrorNode, NodeSpec, SchemaSpec } from "prosemirror-model";
import { Schema } from "prosemirror-model";
import { tableNodes } from "prosemirror-tables";

import { isPlausibleScientSingleDollarTex } from "~/scient/math/scientSingleDollarMath";

const SOURCE_ID_ATTR = { default: null } as const;
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
nodes = nodes.addBefore("image", "display_math", displayMathSpec);
nodes = nodes.addBefore("image", "raw_block", rawBlockSpec);
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
    attrs: { ...spec.attrs, sourceId: SOURCE_ID_ATTR },
  });
}

export const scientMarkdownSchema: Schema = new Schema({
  nodes,
  marks: defaultMarkdownParser.schema.spec.marks,
} satisfies SchemaSpec);

function tableAlignment(token: { readonly attrGet: (name: string) => string | null }): {
  readonly alignment: string | null;
} {
  const style = token.attrGet("style") ?? "";
  const match = /(?:^|;)\s*text-align\s*:\s*(left|center|right)\s*(?:;|$)/iu.exec(style);
  return { alignment: match?.[1]?.toLowerCase() ?? null };
}

const gfmTokenizer = MarkdownIt("commonmark", { html: false }).enable("table");

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

export const scientMarkdownParser = new MarkdownParser(scientMarkdownSchema, gfmTokenizer, {
  ...defaultMarkdownParser.tokens,
  table: { block: "table" },
  thead: { ignore: true },
  tbody: { ignore: true },
  tr: { block: "table_row" },
  th: { block: "table_header", getAttrs: tableAlignment },
  td: { block: "table_cell", getAttrs: tableAlignment },
  scient_inline_math: {
    node: "inline_math",
    getAttrs: (token) => ({ tex: token.content, delimiter: "$" }),
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
    table_row: () => undefined,
    table_cell: () => undefined,
    table_header: () => undefined,
  },
  defaultMarkdownSerializer.marks,
);

export function withMarkdownSourceId(node: ProseMirrorNode, sourceId: string): ProseMirrorNode {
  return node.type.create({ ...node.attrs, sourceId }, node.content, node.marks);
}
