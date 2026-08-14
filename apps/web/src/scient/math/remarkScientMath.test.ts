import { describe, expect, it } from "vite-plus/test";

import { isScientMathCodeClassName, remarkScientMathRefinements } from "./remarkScientMath";

describe("isScientMathCodeClassName", () => {
  it("recognizes the language-math token", () => {
    expect(isScientMathCodeClassName("language-math")).toBe(true);
    expect(isScientMathCodeClassName("language-math math-inline")).toBe(true);
  });

  it("rejects other languages and absent class names", () => {
    expect(isScientMathCodeClassName("language-ts")).toBe(false);
    expect(isScientMathCodeClassName("language-mathml")).toBe(false);
    expect(isScientMathCodeClassName(undefined)).toBe(false);
  });
});

interface TestNode {
  type: string;
  value?: string;
  lang?: string | null;
  children?: TestNode[];
  position?: { start: { offset?: number }; end: { offset?: number } };
}

function refine(tree: TestNode, source: string): TestNode {
  remarkScientMathRefinements()(tree, { toString: () => source });
  return tree;
}

describe("remarkScientMathRefinements", () => {
  it("downgrades an unclosed display block to a literal code block", () => {
    const source = "$$\nx + y";
    const tree: TestNode = {
      type: "root",
      children: [
        {
          type: "math",
          value: "x + y",
          position: { start: { offset: 0 }, end: { offset: source.length } },
        },
      ],
    };
    refine(tree, source);

    expect(tree.children?.[0]?.type).toBe("code");
    expect(tree.children?.[0]?.lang).toBeNull();
    expect(tree.children?.[0]?.value).toBe(source);
  });

  it("keeps a closed display block as math", () => {
    const source = "$$\nx + y\n$$";
    const tree: TestNode = {
      type: "root",
      children: [
        {
          type: "math",
          value: "x + y",
          position: { start: { offset: 0 }, end: { offset: source.length } },
        },
      ],
    };
    refine(tree, source);

    expect(tree.children?.[0]?.type).toBe("math");
  });

  it("strips the math language from an unclosed fence", () => {
    const source = "```math\nx + y";
    const tree: TestNode = {
      type: "root",
      children: [
        {
          type: "code",
          lang: "math",
          value: "x + y",
          position: { start: { offset: 0 }, end: { offset: source.length } },
        },
      ],
    };
    refine(tree, source);

    expect(tree.children?.[0]?.lang).toBeNull();
  });

  it("promotes a paragraph holding a single double-dollar span to display math", () => {
    const tree: TestNode = {
      type: "root",
      children: [{ type: "paragraph", children: [{ type: "inlineMath", value: "x + y" }] }],
    };
    refine(tree, "$$x + y$$");

    expect(tree.children?.[0]?.type).toBe("math");
    expect(tree.children?.[0]?.value).toBe("x + y");
  });

  it("never recognizes single-dollar spans in text", () => {
    const source = "solve $x^2$ now";
    const tree: TestNode = {
      type: "root",
      children: [
        {
          type: "paragraph",
          children: [
            {
              type: "text",
              value: source,
              position: { start: { offset: 0 }, end: { offset: source.length } },
            },
          ],
        },
      ],
    };
    refine(tree, source);
    const children = tree.children?.[0]?.children ?? [];

    expect(children).toHaveLength(1);
    expect(children[0]?.type).toBe("text");
  });

  it("keeps a sole span inline when the author wrote \\(...\\)", () => {
    const sourceText = "\\(x\\)";
    const tree: TestNode = {
      type: "root",
      children: [
        {
          type: "paragraph",
          children: [
            {
              type: "inlineMath",
              value: "x",
              position: { start: { offset: 0 }, end: { offset: 5 } },
            },
          ],
        },
      ],
    };
    remarkScientMathRefinements({ sourceText })(tree, { toString: () => "$$x$$" });

    expect(tree.children?.[0]?.type).toBe("paragraph");
    expect(tree.children?.[0]?.children?.[0]?.type).toBe("inlineMath");
  });

  it("breaks out a mid-paragraph \\[...\\] span as display math", () => {
    const sourceText = "prose \\[x\\] end";
    const normalized = "prose $$x$$ end";
    const tree: TestNode = {
      type: "root",
      children: [
        {
          type: "paragraph",
          children: [
            {
              type: "text",
              value: "prose ",
              position: { start: { offset: 0 }, end: { offset: 6 } },
            },
            {
              type: "inlineMath",
              value: "x",
              position: { start: { offset: 6 }, end: { offset: 11 } },
            },
            {
              type: "text",
              value: " end",
              position: { start: { offset: 11 }, end: { offset: 15 } },
            },
          ],
        },
      ],
    };
    remarkScientMathRefinements({ sourceText })(tree, { toString: () => normalized });

    expect(tree.children?.map((child) => child.type)).toEqual(["paragraph", "math", "paragraph"]);
    expect(tree.children?.[1]?.value).toBe("x");
    expect(tree.children?.[0]?.children?.[0]?.value).toBe("prose");
    expect(tree.children?.[2]?.children?.[0]?.value).toBe("end");
  });
});
