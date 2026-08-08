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
    expect(elements[3]?.children?.[0]?.properties?.dir).toBe("rtl");
    expect(elements[3]?.children?.[1]?.properties?.dir).toBe("rtl");
    expect(elements[4]?.properties).toBeUndefined();
  });

  it("keeps headings in the message direction when their text differs", () => {
    const tree = {
      type: "root",
      children: [
        {
          type: "element",
          tagName: "h2",
          children: [{ type: "text", value: "Methods and Results" }],
        },
        {
          type: "element",
          tagName: "p",
          children: [{ type: "text", value: "ממצאים ותוצאות" }],
        },
      ],
    };

    rehypeScientBidi({ direction: "rtl" })(tree);

    const elements = tree.children as Array<{ properties?: Record<string, unknown> }>;
    expect(elements[0]?.properties?.dir).toBe("rtl");
    expect(elements[1]?.properties?.dir).toBe("rtl");
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

  it("keeps every normal cell in the aggregate table direction", () => {
    const tree = {
      type: "root",
      children: [
        {
          type: "element",
          tagName: "table",
          children: [
            {
              type: "element",
              tagName: "tr",
              children: [
                {
                  type: "element",
                  tagName: "th",
                  children: [{ type: "text", value: "שם" }],
                },
                {
                  type: "element",
                  tagName: "td",
                  children: [
                    {
                      type: "element",
                      tagName: "h3",
                      children: [{ type: "text", value: "English label" }],
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

    const table = tree.children?.[0] as {
      children?: Array<{
        children?: Array<{ children?: Array<unknown>; properties?: Record<string, unknown> }>;
      }>;
      properties?: Record<string, unknown>;
    };
    const row = table.children?.[0];
    expect(table.properties?.dir).toBe("rtl");
    expect(row?.children?.[0]?.properties?.dir).toBe("rtl");
    expect(row?.children?.[1]?.properties?.dir).toBe("rtl");
    const heading = row?.children?.[1]?.children?.[0] as {
      properties?: Record<string, unknown>;
    };
    expect(heading.properties?.dir).toBe("rtl");
  });

  it("keeps a table nested in a list on its own aggregate direction", () => {
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
                { type: "text", value: "פריט" },
                {
                  type: "element",
                  tagName: "table",
                  children: [
                    {
                      type: "element",
                      tagName: "td",
                      children: [{ type: "text", value: "English" }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };

    rehypeScientBidi({ direction: "rtl" })(tree);

    const list = tree.children?.[0] as {
      children?: Array<{ children?: Array<{ properties?: Record<string, unknown> }> }>;
    };
    const table = list.children?.[0]?.children?.[1] as {
      properties?: Record<string, unknown>;
      children?: Array<{ properties?: Record<string, unknown> }>;
    };
    expect(table.properties?.dir).toBe("ltr");
    expect(table.children?.[0]?.properties?.dir).toBe("ltr");
  });

  it("keeps explicit LTR authoritative for Hebrew table cells", () => {
    const tree = {
      type: "root",
      children: [
        {
          type: "element",
          tagName: "table",
          children: [
            {
              type: "element",
              tagName: "td",
              children: [{ type: "text", value: "שלום" }],
            },
          ],
        },
      ],
    };

    rehypeScientBidi({ direction: "ltr", requestedDirection: "ltr" })(tree);

    const table = tree.children?.[0] as {
      properties?: Record<string, unknown>;
      children?: Array<{ properties?: Record<string, unknown> }>;
    };
    expect(table.properties?.dir).toBe("ltr");
    expect(table.children?.[0]?.properties?.dir).toBe("ltr");
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
