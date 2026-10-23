import { describe, expect, it } from "vite-plus/test";
import { detectType, load, parse } from "pele/lazy";
import { blockedMermaidResources, mermaidModelResources } from "./blockedMermaidResources";

describe("authored diagram resource notices", () => {
  it.each([
    `flowchart LR\nA["icon: 'https://example.org/reference'"] --> B`,
    `flowchart LR\nA[img: 'https://example.org/reference'] --> B`,
    `flowchart LR\nA["favicon: 'https://example.org/reference'; img: 'https://example.org/reference'"] --> B`,
    `flowchart LR\n%% A@{ img: 'https://example.org/reference' }\n%% properties A: {"icon":"https://example.org/reference"}\nA --> B`,
    `flowchart LR\nA@{ label: "icon: 'https://example.org/reference'" } --> B`,
    `sequenceDiagram\nparticipant A as icon: 'https://example.org/reference'\nA->>A: img: 'https://example.org/reference'`,
  ])("keeps resource-looking labels, suffix words and comments opaque: %s", async (source) => {
    await load(detectType(source));
    const resources = mermaidModelResources(parse(source));
    expect(resources).toEqual([]);
    expect(blockedMermaidResources(source, resources)).toEqual([]);
  });

  it.each([
    `flowchart LR\nA@{ img: "https://example.invalid/resource" } --> B`,
    `flowchart LR\nA@{ icon: "https://example.invalid/resource" } --> B`,
    `flowchart LR\nA@{\n img: 'https://example.invalid/resource'\n label: 'Picture'\n} --> B`,
    `flowchart LR\nA["icon: 'https://example.org/reference'"] --> B@{ img: "https://example.invalid/resource" }`,
    `sequenceDiagram\nparticipant A\nproperties A: {"icon":"https://example.invalid/resource"}\nA->>A: hi`,
    `sequenceDiagram\nparticipant A;properties A: {"icon":"https://example.invalid/resource"}\nA->>A: hi`,
    `sequenceDiagram\nparticipant A\nproperties A: {"\\u0069con":"https://example.invalid/\\u0072esource"}\nA->>A: hi`,
  ])("names only parsed image/actor resource fields: %s", async (source) => {
    await load(detectType(source));
    const resources = mermaidModelResources(parse(source));
    expect(resources).toEqual(["https://example.invalid/resource"]);
    expect(blockedMermaidResources(source, resources)).toEqual([
      "https://example.invalid/resource",
    ]);
  });

  it("does not classify prose URL/image functions or later node labels as fetching CSS", () => {
    for (const source of [
      'flowchart LR\nA["mentions url(x), image(y) and @import"] --> B',
      'flowchart LR\nA["https://example.org/url(report)"]',
      'flowchart LR\nstyle A fill:red; B["url(x)"]',
      'flowchart LR\nA["a;style x url(y)"] --> B',
    ])
      expect(blockedMermaidResources(source), source).toEqual([]);
  });

  it("still names resource-bearing styles, decoded CSS escapes and ignored configuration", () => {
    expect(
      blockedMermaidResources(
        "stateDiagram-v2\nclassDef c fill:red; background-image:u\\72l(https://example.invalid/a.png)",
      ),
    ).toContain("https://example.invalid/a.png");
    expect(
      blockedMermaidResources(
        '%%{init: {"themeCSS": "@font-face{src:url(https://example.invalid/font.woff2)}"}}%%\nflowchart LR\nA',
      ),
    ).toContain("https://example.invalid/font.woff2");
  });
});
