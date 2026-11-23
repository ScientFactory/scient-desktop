import { describe, expect, it } from "vite-plus/test";

import {
  notebookOverrideAllowed,
  notebookParameterJson,
  readNotebookParameters,
} from "./notebookParameters.ts";

describe("notebook parameters", () => {
  it("reads literal defaults without treating expressions or nested bindings as values", () => {
    const python = readNotebookParameters(
      '# defaults\nlimit = -2.5e1\nlabel = "p#1" # comment\nfeatures = [\n  "x", True, [2],\n]\nother = limit * 2\nif True:\n    local = 3',
      "python",
    );
    expect(python.map(({ name, value }) => [name, value])).toEqual([
      ["limit", -25],
      ["label", "p#1"],
      ["features", ["x", true, [2]]],
      ["other", undefined],
    ]);
    expect(
      readNotebookParameters("labels <- list('a', TRUE)\nxs = c(1, 2)\ncoerced = c(1, 'a')", "r"),
    ).toMatchObject([{ value: ["a", true] }, { value: [1, 2] }, { value: undefined }]);
    expect(readNotebookParameters('xs = [false, true]\nname = "$who"', "julia")).toMatchObject([
      { value: [false, true] },
      { value: undefined },
    ]);
  });

  it("keeps decimal spelling and lists annotated and multi-statement assignments", () => {
    const [rate, count, computed, first, second] = readNotebookParameters(
      "rate: float = 1.0\ncount = 2\ncomputed: float = rate / 2\nfirst = 1; second = 2",
      "python",
    );
    expect(rate).toMatchObject({
      name: "rate",
      value: 1,
      defaultJson: "1.0",
      numericKind: "decimal",
    });
    expect(notebookParameterJson(rate!, 2)).toBe("2.0");
    expect(notebookOverrideAllowed(count!, 2.5)).toBe(false);
    expect([computed, first, second].map((value) => [value?.name, value?.value])).toEqual([
      ["computed", undefined],
      ["first", undefined],
      ["second", undefined],
    ]);
    expect(readNotebookParameters("const limit = 3", "julia")).toMatchObject([
      { name: "limit", value: undefined },
    ]);
  });
});
