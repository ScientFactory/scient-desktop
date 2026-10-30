import { describe, expect, it } from "vite-plus/test";

import { indexNotebook, notebookBytes, notebookText } from "./notebookIndex.ts";

const notebook = {
  cells: [
    {
      cell_type: "markdown",
      id: "text",
      metadata: {},
      source: ['# Title "quoted"\n', "more \\ text"],
    },
    {
      cell_type: "code",
      execution_count: 2,
      id: "code",
      metadata: { tags: ["keep"] },
      outputs: [
        { name: "stdout", output_type: "stream", text: ['a "b"\n'] },
        {
          data: { "image/png": "QUJD".repeat(1000), "text/plain": ["<Figure>"] },
          metadata: {},
          output_type: "display_data",
        },
      ],
      source: "x = 1",
    },
  ],
  metadata: { language_info: { name: "R" } },
  nbformat: 4,
  nbformat_minor: 5,
};

describe("indexNotebook", () => {
  it("reads structure and outputs without touching saved bytes", () => {
    const bytes = Buffer.from(`${JSON.stringify(notebook, null, 1)}\n`);
    const index = indexNotebook(bytes);
    expect(index.language).toBe("r");
    expect(index.cells.map((cell) => cell.id)).toEqual(["text", "code"]);
    expect(notebookText(index.cells[0]?.fields.source)).toBe('# Title "quoted"\nmore \\ text');
    expect(index.cells[1]?.outputIndex.map((output) => output.outputType)).toEqual([
      "stream",
      "display_data",
    ]);
    expect(index.cells[1]?.outputIndex[1]?.mediaTypes).toEqual(["image/png", "text/plain"]);
    expect(JSON.parse(notebookBytes(index).toString())).toEqual(notebook);
  });

  it("copies unedited cells byte for byte when another cell changes", () => {
    const bytes = Buffer.from(`${JSON.stringify(notebook, null, 1)}\n`);
    const index = indexNotebook(bytes);
    const [first, second] = index.cells;
    const edited = {
      ...index,
      cells: [
        { ...first!, fields: { ...first!.fields, source: ["changed"] }, saved: null },
        second!,
      ],
    };
    const written = notebookBytes(edited).toString();
    expect(JSON.parse(written).cells[0].source).toEqual(["changed"]);
    expect(JSON.parse(written).cells[1]).toEqual(notebook.cells[1]);
    expect(written).toContain(second!.saved!.toString());
  });

  it("keeps outputs when a code cell is rewritten", () => {
    const index = indexNotebook(Buffer.from(JSON.stringify(notebook)));
    const code = index.cells[1]!;
    const edited = { ...index, cells: [{ ...code, saved: null }] };
    expect(JSON.parse(notebookBytes(edited).toString()).cells[0]).toEqual(notebook.cells[1]);
  });

  it("gives older cells an id and moves the notebook to nbformat 4.5", () => {
    const old = {
      cells: [{ cell_type: "code", execution_count: null, metadata: {}, outputs: [], source: "" }],
      metadata: {},
      nbformat: 4,
      nbformat_minor: 2,
    };
    const written = JSON.parse(
      notebookBytes(indexNotebook(Buffer.from(JSON.stringify(old)))).toString(),
    );
    expect(written.cells[0].id).toBe("cell-1");
    expect(written.nbformat_minor).toBe(5);
  });

  it("indexes an empty file and rejects text that is not a notebook", () => {
    expect(indexNotebook(Buffer.alloc(0)).cells).toEqual([]);
    expect(() => indexNotebook(Buffer.from("[1, 2]"))).toThrow();
    expect(() => indexNotebook(Buffer.from('{"a": "unterminated'))).toThrow();
  });

  it("rejects mismatched brackets instead of looping", () => {
    expect(() => indexNotebook(Buffer.from('{"cells":[}}'))).toThrow();
    expect(() => indexNotebook(Buffer.from('{"cells":[1 2]}'))).toThrow();
    expect(() => indexNotebook(Buffer.from('{"cells":[{"a":1,}]}'))).toThrow();
  });

  it("gives a cell without an id one that no other cell uses", () => {
    const cells = [
      { cell_type: "code", execution_count: null, metadata: {}, outputs: [], source: "" },
      {
        cell_type: "code",
        execution_count: null,
        id: "cell-1",
        metadata: {},
        outputs: [],
        source: "",
      },
      {
        cell_type: "code",
        execution_count: null,
        id: "cell-1",
        metadata: {},
        outputs: [],
        source: "",
      },
    ];
    const index = indexNotebook(Buffer.from(JSON.stringify({ ...notebook, cells })));
    expect(new Set(index.cells.map((cell) => cell.id)).size).toBe(3);
    expect(index.cells[1]?.id).toBe("cell-1");
  });

  it("keeps a cell whose text looks like anything the writer might use", () => {
    const odd = {
      cell_type: "code",
      execution_count: null,
      id: "odd",
      metadata: {},
      outputs: [{ name: "stdout", output_type: "stream", text: ["x"] }],
      source: ["\u0000scient-outputs"],
    };
    const index = indexNotebook(Buffer.from(JSON.stringify({ ...notebook, cells: [odd] })));
    const rewritten = { ...index, cells: index.cells.map((cell) => ({ ...cell, saved: null })) };
    expect(JSON.parse(notebookBytes(rewritten).toString()).cells[0]).toEqual(odd);
  });

  it("skips long stored figures and keeps escaped quotes inside strings", () => {
    const figure = `${"A".repeat(2_000_000)}\\"end`;
    const big = {
      cells: [
        {
          cell_type: "code",
          execution_count: 1,
          id: "figure",
          metadata: {},
          outputs: [{ data: { "image/png": figure }, metadata: {}, output_type: "display_data" }],
          source: "x",
        },
      ],
      metadata: {},
      nbformat: 4,
      nbformat_minor: 5,
    };
    const index = indexNotebook(Buffer.from(JSON.stringify(big)));
    expect(index.cells[0]?.outputIndex[0]?.mediaTypes).toEqual(["image/png"]);
    expect(JSON.parse(notebookBytes(index).toString())).toEqual(big);
  });
});
