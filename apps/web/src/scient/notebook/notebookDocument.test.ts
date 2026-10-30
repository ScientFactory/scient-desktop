import { describe, expect, it } from "vite-plus/test";

import { parseNotebook, serializeNotebook, updateNotebookCell } from "./notebookDocument";

const saved = {
  cells: [
    {
      cell_type: "code",
      execution_count: 3,
      id: "a1",
      metadata: { tags: ["keep"] },
      outputs: [{ output_type: "stream", name: "stdout", text: ["1\n", "2\n"] }],
      source: ["x = 1\n", "x"],
    },
    { cell_type: "markdown", id: "b2", metadata: {}, source: "# Title", attachments: {} },
  ],
  metadata: { kernelspec: { name: "python3", language: "python" }, custom: { a: 1 } },
  nbformat: 4,
  nbformat_minor: 4,
};

describe("notebookDocument", () => {
  it("keeps what it does not edit through a round trip", () => {
    const document = parseNotebook(JSON.stringify(saved));
    expect(document?.language).toBe("python");
    const edited = updateNotebookCell(document!, "a1", (cell) => ({ ...cell, source: "x = 2\n" }));
    const written = JSON.parse(serializeNotebook(edited));
    expect(written.metadata).toEqual(saved.metadata);
    expect(written.nbformat_minor).toBe(5);
    expect(written.cells[0]).toEqual({ ...saved.cells[0], source: ["x = 2\n"] });
    expect(written.cells[1]).toEqual(saved.cells[1]);
  });
});
