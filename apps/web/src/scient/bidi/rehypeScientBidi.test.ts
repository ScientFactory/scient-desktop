import { describe, expect, it } from "vite-plus/test";

import { rehypeScientBidi } from "./rehypeScientBidi";

describe("rehypeScientBidi", () => {
  it("keeps one direction for a complete mixed list", () => {
    const tree = {
      type: "root",
      children: [
        {
          type: "element",
          tagName: "p",
          children: [{ type: "text", value: "RF — רגיש מאוד" }],
        },
        {
          type: "element",
          tagName: "p",
          children: [{ type: "text", value: "Methods and Results" }],
        },
        {
          type: "element",
          tagName: "ul",
          children: [
            {
              type: "element",
              tagName: "li",
              children: [{ type: "text", value: "Anti-CCP — ספציפי" }],
            },
            {
              type: "element",
              tagName: "li",
              children: [{ type: "text", value: "Standard deviation" }],
            },
          ],
        },
        {
          type: "element",
          tagName: "table",
          children: [
            {
              type: "element",
              tagName: "th",
              children: [{ type: "text", value: "OA" }],
            },
            {
              type: "element",
              tagName: "td",
              children: [{ type: "text", value: "אוטואימונית" }],
            },
          ],
        },
        { type: "element", tagName: "code", children: [] },
      ],
    };

    rehypeScientBidi({ direction: "rtl" })(tree);

    const elements = tree.children as Array<{
      children?: Array<{ properties?: Record<string, unknown> }>;
      properties?: Record<string, unknown>;
    }>;
    expect(elements[0]?.properties?.dir).toBe("rtl");
    expect(elements[1]?.properties?.dir).toBe("ltr");
    expect(elements[2]?.properties?.dir).toBe("rtl");
    expect(elements[2]?.children?.[0]?.properties).toBeUndefined();
    expect(elements[2]?.children?.[1]?.properties).toBeUndefined();
    expect(elements[3]?.properties?.dir).toBe("rtl");
    expect(elements[3]?.children?.[0]?.properties?.dir).toBe("ltr");
    expect(elements[3]?.children?.[1]?.properties?.dir).toBe("rtl");
    expect(elements[4]?.properties).toBeUndefined();
  });

  it("uses one direction for an English-only list and keeps children inheriting", () => {
    const tree = {
      type: "root",
      children: [
        {
          type: "element",
          tagName: "ol",
          children: [
            {
              type: "element",
              tagName: "li",
              children: [{ type: "text", value: "Standard deviation" }],
            },
            {
              type: "element",
              tagName: "li",
              children: [{ type: "text", value: "Confidence interval" }],
            },
          ],
        },
      ],
    };

    rehypeScientBidi({ direction: "rtl" })(tree);

    const list = tree.children?.[0] as {
      children?: Array<{ properties?: Record<string, unknown> }>;
      properties?: Record<string, unknown>;
    };
    expect(list.properties?.dir).toBe("ltr");
    expect(list.children?.[0]?.properties).toBeUndefined();
    expect(list.children?.[1]?.properties).toBeUndefined();
  });

  it("uses one direction for an English-only table inside an RTL message", () => {
    const tree = {
      type: "root",
      children: [
        {
          type: "element",
          tagName: "table",
          children: [
            {
              type: "element",
              tagName: "th",
              children: [{ type: "text", value: "OA" }],
            },
            {
              type: "element",
              tagName: "td",
              children: [{ type: "text", value: "Standard deviation" }],
            },
          ],
        },
      ],
    };

    rehypeScientBidi({ direction: "rtl" })(tree);

    const table = tree.children?.[0] as {
      children?: Array<{ properties?: Record<string, unknown> }>;
      properties?: Record<string, unknown>;
    };
    expect(table.properties?.dir).toBe("ltr");
    expect(table.children?.[0]?.properties?.dir).toBe("ltr");
    expect(table.children?.[1]?.properties?.dir).toBe("ltr");
  });

  it("keeps nested lists in the parent list direction", () => {
    const tree = {
      type: "root",
      children: [
        {
          type: "element",
          tagName: "ul",
          children: [
            {
              type: "element",
              tagName: "li",
              children: [
                { type: "text", value: "ממצא" },
                {
                  type: "element",
                  tagName: "ol",
                  children: [
                    {
                      type: "element",
                      tagName: "li",
                      children: [{ type: "text", value: "English detail" }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };

    rehypeScientBidi({ direction: "ltr" })(tree);

    const list = tree.children?.[0] as {
      children?: Array<{ children?: Array<{ properties?: Record<string, unknown> }> }>;
      properties?: Record<string, unknown>;
    };
    const nestedList = list.children?.[0]?.children?.[1] as {
      children?: Array<{ properties?: Record<string, unknown> }>;
      properties?: Record<string, unknown>;
    };
    expect(list.properties?.dir).toBe("rtl");
    expect(nestedList.properties?.dir).toBe("rtl");
    expect(nestedList.children?.[0]?.properties).toBeUndefined();
  });

  it("respects an explicit conversation direction for the whole list", () => {
    const tree = {
      type: "root",
      children: [
        {
          type: "element",
          tagName: "ul",
          children: [
            {
              type: "element",
              tagName: "li",
              children: [{ type: "text", value: "Hebrew — שלום" }],
            },
          ],
        },
      ],
    };

    rehypeScientBidi({ direction: "ltr", requestedDirection: "ltr" })(tree);

    const list = tree.children?.[0] as { properties?: Record<string, unknown> };
    expect(list.properties?.dir).toBe("ltr");
  });
});
