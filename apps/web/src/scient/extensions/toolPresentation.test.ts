import { describe, expect, it } from "vite-plus/test";
import semanticScholar from "./semanticScholar.fixture.json";
import {
  toolDescription,
  toolDisplayName,
  toolMakesChanges,
  toolSummary,
} from "./toolPresentation";

describe("tool presentation", () => {
  it.each([
    [{ name: "ignored_id", title: "  Find a paper  " }, "Find a paper"],
    [{ name: "get_paper_batch" }, "Get paper batch"],
    [{ name: "getPDFById" }, "Get PDF by ID"],
    [{ name: "parse-url-JSON", title: " " }, "Parse URL JSON"],
  ])("humanizes %j without losing acronyms", (tool, expected) => {
    expect(toolDisplayName(tool)).toBe(expected);
  });

  it("cuts prose before arguments, returns and examples and bounds a long first sentence", () => {
    expect(toolSummary(semanticScholar.description)).toBe("Get details about a paper by its id.");
    expect(toolSummary("Fetch results Parameters: query: text")).toBe("Fetch results");
    expect(toolSummary("Fetch results Returns: results")).toBe("Fetch results");
    expect(toolSummary("Fetch results Example: query(foo)")).toBe("Fetch results");
    expect(toolSummary("Find citations (i.e. papers citing this one). More details.")).toBe(
      "Find citations (i.e. papers citing this one).",
    );
    expect(toolSummary("First sentence! Second sentence.")).toBe("First sentence!");
    expect(toolSummary("x".repeat(200))).toBe(`${"x".repeat(177)}…`);
    expect(toolSummary(undefined)).toBe("");
  });

  it("turns the real Semantic Scholar docstring into parameters, nested ID bullets and returns", () => {
    const markdown = toolDescription(semanticScholar);
    expect(markdown).toContain("## Parameters\n\n- `paper_id`");
    expect(markdown).toContain("  - `DOI:<doi>`: a Digital Object Identifier");
    expect(markdown).toContain("- `fields`\n\n  String of comma-separated fields");
    expect(markdown).toContain('Default is "title". Available fields are: abstract');
    expect(markdown).toContain("## Returns\n\nThe paper object.");
    expect(markdown).not.toContain("Args:");
  });

  it("prefers schema metadata and descriptions, filling missing descriptions from the docstring", () => {
    const markdown = toolDescription({
      ...semanticScholar,
      parameters: [
        { name: "paper_id", type: "string", required: true },
        { name: "fields", type: "string", required: false, description: "Schema description." },
      ],
    });
    expect(markdown).toContain("- `paper_id` (string, required)");
    expect(markdown).toContain("The id of the paper to get.");
    expect(markdown).toContain("- `fields` (string, optional)\n\n  Schema description.");
    expect(markdown).not.toContain("String of comma-separated");
  });

  it("preserves fallback Markdown and unrecognized parameter prose", () => {
    const description = "A paragraph.\n\n- Parent\n  - Child\n\n```python\nif True:\n    pass\n```";
    expect(toolDescription({ name: "custom", description })).toBe(description);
    expect(
      toolDescription({
        name: "custom",
        description: "Lead\nParameters:\nFree-form notes.\nReturns:\nA list.",
      }),
    ).toContain("## Parameters\n\n\n\nFree-form notes.");
    expect(toolDescription({ name: "empty" })).toBe("");
  });

  it("only marks changes when the annotations establish them, including conflicting hints", () => {
    expect(
      [
        {},
        { readOnly: true },
        { destructive: false },
        { readOnly: false },
        { readOnly: true, destructive: true },
      ].map((hints) => toolMakesChanges({ name: "tool", ...hints })),
    ).toEqual([false, false, false, true, true]);
  });
});
