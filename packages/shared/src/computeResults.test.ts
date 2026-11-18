import { describe, expect, it } from "vite-plus/test";

import {
  findMarkdownResultReferences,
  formatResultFigureMarkdown,
  formatResultTarget,
  formatResultValueMarkdown,
  parseResultTarget,
  readResultValues,
  resultPointer,
  resultValueAt,
} from "./computeResults";

const revision = "r0123456789ab";

describe("linked result references", () => {
  it("round-trips targets whose paths and keys need escaping", () => {
    const target = {
      revision,
      output: "tables/main results.json",
      pointer: resultPointer(["cohort", "n/excluded", "~x"]),
    };
    const href = formatResultTarget(target);
    expect(href).not.toMatch(/\s/u);
    expect(parseResultTarget(href)).toEqual(target);
    expect(parseResultTarget(`scient-result:${revision}/../values.json#/a`)).toBeNull();
    expect(parseResultTarget("scient-result:not-a-revision/values.json")).toBeNull();
  });

  it("finds values and figures in Markdown, outside code fences", () => {
    const value = formatResultValueMarkdown("<0.001 [adj]", {
      revision,
      output: "values.json",
      pointer: "/p",
    });
    const figure = formatResultFigureMarkdown(
      { alt: "Kaplan–Meier", src: "assets/results/km.png" },
      { revision, output: "km.png", pointer: null },
    );
    const source = `p ${value}.\n\n${figure}\n\n\`\`\`\n[1](scient-result:${revision}/values.json#/n)\n\`\`\`\n`;
    const references = findMarkdownResultReferences(source);
    expect(references.map((reference) => reference.kind)).toEqual(["value", "figure"]);
    expect(references[0]).toMatchObject({ text: "<0.001 [adj]", pointer: "/p" });
    expect(references[1]).toMatchObject({ alt: "Kaplan–Meier", src: "assets/results/km.png" });
    expect(source.slice(references[0]!.start, references[0]!.end)).toBe(value);
  });

  it("reads numbers as written, so formatting chosen in the analysis survives", () => {
    const text = '{"hr": 0.720, "n": 1204, "ci": ["0.61", 0.85], "fit": {"ok": true}}';
    expect(readResultValues(text)).toEqual([
      { pointer: "/hr", value: "0.720" },
      { pointer: "/n", value: "1204" },
      { pointer: "/ci/0", value: "0.61" },
      { pointer: "/ci/1", value: "0.85" },
    ]);
    expect(resultValueAt(text, "/hr")).toBe("0.720");
    expect(resultValueAt(text, "/fit/ok")).toBeNull();
    expect(readResultValues("not json")).toBeNull();
  });
});
