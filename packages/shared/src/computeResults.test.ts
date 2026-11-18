import type { ComputeResultResolution, ComputeResultRevisionId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  findMarkdownResultReferences,
  formatResultFigureMarkdown,
  formatResultTableCaption,
  formatResultTarget,
  formatResultValueMarkdown,
  parseResultTarget,
  readResultValues,
  resultPointer,
  resultReferenceState,
  resultValueAt,
} from "./computeResults.ts";

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
    const parenthesized = { revision, output: "fig (a).png", pointer: null };
    expect(formatResultTarget(parenthesized)).not.toMatch(/[()]/u);
    expect(parseResultTarget(formatResultTarget(parenthesized))).toEqual(parenthesized);
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
    // A value inside a sentence cannot hold a paragraph break.
    expect(readResultValues('{"note": "a\\n\\nb"}')).toEqual([]);
    expect(resultValueAt('{"a\\u0000b": "1", "a": {"b": "2"}}', "/a/b")).toBe("2");
  });

  it("finds a table by its caption link and compares its rows with the run", () => {
    const caption = formatResultTableCaption("Table 1", {
      revision,
      output: "table1.csv",
      pointer: null,
    });
    expect(caption).toBe(`Table: [Table 1](scient-result:${revision}/table1.csv)`);
    const source = `| Arm | n |\n|---|--:|\n| A | 1 |\n\n${caption}\n`;
    expect(findMarkdownResultReferences(source)).toMatchObject([
      { kind: "table", caption: "Table 1", output: "table1.csv", pointer: null },
    ]);
    const rows = [
      ["Arm", "n"],
      ["A", "1"],
    ];
    const resolved = (
      table: ReadonlyArray<ReadonlyArray<string>> | null,
    ): ComputeResultResolution => ({
      _tag: "resolved",
      summary: {
        revision: revision as ComputeResultRevisionId,
        scriptPath: "analysis.py",
        language: "Python",
        finishedAt: "2026-11-18T00:00:00.000Z",
        runtime: { executable: null, version: null },
        inputTracking: "observed",
        inputs: [],
        inputsTruncated: false,
        causes: [],
      },
      value: null,
      figure: false,
      table,
      newer: null,
    });
    expect(resultReferenceState({ kind: "table", rows }, resolved(rows))).toBe("current");
    expect(
      resultReferenceState(
        {
          kind: "table",
          rows: [
            ["Arm", "n"],
            ["A", "2"],
          ],
        },
        resolved(rows),
      ),
    ).toBe("edited");
    expect(resultReferenceState({ kind: "table", rows: null }, resolved(rows))).toBe("current");
    expect(resultReferenceState({ kind: "table", rows }, resolved(null))).toBe("missing");
  });
});
