import { describe, expect, it } from "vite-plus/test";

import { rehypeScientBidi } from "./rehypeScientBidi";

const text = (value: string) => ({ type: "text", value });
const element = (
  tagName: string,
  children: object[],
  properties: Record<string, unknown> = {},
) => ({
  type: "element",
  tagName,
  properties,
  children,
});

function directed(...blocks: ReturnType<typeof element>[]) {
  rehypeScientBidi({ direction: "ltr", requestedDirection: "auto" })({
    type: "root",
    children: blocks,
  });
  return blocks;
}

describe("rehypeScientBidi upstream assertion conservation", () => {
  it("keeps raw HTML list items apart when counting words", () => {
    const [list] = directed(
      element("ul", [element("li", [text("مرحبا")]), element("li", [text("hello world")])]),
    );
    expect(list!.properties.dir).toBe("ltr");
  });

  it("leaves inline code out of the prose count", () => {
    const code = element("code", [text("useEffect useLayoutEffect React")]);
    const [paragraph] = directed(element("p", [text("استخدم "), code, text(" هنا")]));
    expect(paragraph!.properties.dir).toBe("rtl");
  });

  it("leaves code blocks to their own left-to-right frame", () => {
    const code = element("code", [text("// احسب المجموع هنا")]);
    const [pre] = directed(element("pre", [code]));
    expect(pre!.properties.dir).toBeUndefined();
    expect(code.properties.dir).toBeUndefined();
  });

  it("keeps authored ltr/rtl dir and replaces other dir values with detected direction", () => {
    const cases = [
      ["rtl", "Hello world", "rtl"],
      ["ltr", "مرحبا بالعالم", "ltr"],
      ["RTL", "Hello world", "RTL"],
      ["auto", "مرحبا بالعالم", "rtl"],
      [" rtl", "مرحبا بالعالم", "rtl"],
    ] as const;
    for (const [authored, sample, expected] of cases) {
      const [block] = directed(element("p", [text(sample)], { dir: authored }));
      expect(block!.properties.dir, `dir=${JSON.stringify(authored)}`).toBe(expected);
    }
  });
});
