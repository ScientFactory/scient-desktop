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
  "raw_block",
] as const;

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

let nodes = defaultMarkdownParser.schema.spec.nodes.addBefore("image", "raw_block", rawBlockSpec);
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

export const scientMarkdownParser = new MarkdownParser(scientMarkdownSchema, gfmTokenizer, {
  ...defaultMarkdownParser.tokens,
  table: { block: "table" },
  thead: { ignore: true },
  tbody: { ignore: true },
  tr: { block: "table_row" },
  th: { block: "table_header", getAttrs: tableAlignment },
  td: { block: "table_cell", getAttrs: tableAlignment },
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
