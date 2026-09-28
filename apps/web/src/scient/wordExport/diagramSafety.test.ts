import { describe, expect, it } from "vite-plus/test";

import { mermaidConfigFetchRisk, mermaidStyleFetchRisk } from "./diagramSafety";

describe("mermaidStyleFetchRisk", () => {
  it("leaves label text alone, however it mentions url( or addresses", () => {
    for (const source of [
      'flowchart LR\nA["https://example.org/url(report)"] --> B',
      'flowchart LR\nA["a label that mentions url(x)"] --> B["@import"]',
      'flowchart LR\nA["url(x)"];style A fill:#f9f,stroke:#333',
      "flowchart LR\nA[see image-set(x) docs] --> B\nclassDef note fill:#ffe",
    ]) {
      expect(mermaidStyleFetchRisk(source), source).toBeNull();
    }
  });

  it("finds fetching CSS in styling statements, escaped or joined with ;", () => {
    for (const source of [
      "flowchart LR\nA --> B\nstyle A fill:url(https://example.invalid/p)",
      "stateDiagram-v2\nclassDef c background-image:u\\72l(//example.invalid/p)",
      "flowchart LR\nA --> B;linkStyle 0 stroke:url(#x)",
      "classDiagram\nclass A\ncssClass \"A\" x;classDef x background:image-set('p.png' 1x)",
      "flowchart LR\nA --> B\n  classDef c font:@\\69mport",
    ]) {
      expect(mermaidStyleFetchRisk(source), source).not.toBeNull();
    }
  });
});

describe("mermaidConfigFetchRisk", () => {
  it("allows theme, layout, and per-diagram options and refuses the rest", () => {
    expect(mermaidConfigFetchRisk({})).toBeNull();
    expect(
      mermaidConfigFetchRisk({
        theme: "base",
        themeVariables: { primaryColor: "#ff0000", fontSize: "14px" },
        flowchart: { curve: "linear", nodeSpacing: 40 },
        wrap: true,
      }),
    ).toBeNull();
    expect(mermaidConfigFetchRisk({ themeCSS: ".node { fill: red }" })).not.toBeNull();
    expect(mermaidConfigFetchRisk({ fontFamily: "Inter" })).not.toBeNull();
    expect(mermaidConfigFetchRisk({ themeVariables: { primaryColor: "url(x)" } })).not.toBeNull();
    expect(mermaidConfigFetchRisk({ themeVariables: { primaryColor: "<b>" } })).not.toBeNull();
  });
});
