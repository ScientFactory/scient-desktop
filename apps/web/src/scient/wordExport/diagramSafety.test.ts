import { describe, expect, it } from "vite-plus/test";

import {
  mermaidConfigFetchRisk,
  mermaidStyleFetchRisk,
  mermaidSourceConfigFetchRisk,
} from "./diagramSafety";

describe("mermaidStyleFetchRisk", () => {
  it("leaves label text alone, however it mentions url( or addresses", () => {
    for (const source of [
      'flowchart LR\nA["https://example.org/url(report)"] --> B',
      'flowchart LR\nA["a label that mentions url(x)"] --> B["@import"]',
      'flowchart LR\nA["url(x)"];style A fill:#f9f,stroke:#333',
      "flowchart LR\nA[see image-set(x) docs] --> B\nclassDef note fill:#ffe",
      // Statements after a style end it; their labels are not styles.
      'flowchart LR\nA-->B\nstyle A fill:#f9f; B["https://example.org/url(report)"]',
      'flowchart LR\nstyle A fill:#f9f;B:::c["url(x)"]',
      'flowchart LR\nA["a;style x url(y)"] --> B',
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
      // A style list read to the end of the line keeps its later declarations.
      "stateDiagram-v2\nclassDef c fill:red; background-image:url(https://example.invalid/p)",
      'flowchart LR\nA-->B; style A stroke:#333 ; B["x"]; linkStyle 0 stroke:url(#x)',
    ]) {
      expect(mermaidStyleFetchRisk(source), source).not.toBeNull();
    }
  });
});

describe("authored Mermaid configuration", () => {
  it("allows safe YAML and both supported directive quote styles without interpreting labels as config", () => {
    for (const source of [
      'flowchart LR\nA["url(x), image(y), @import and https://example.org"]',
      "%%{init: {'theme': 'forest', 'flowchart': {'curve': 'linear'}}}%%\nflowchart LR\nA",
      '%%{initialize: {"theme": "base", "themeVariables": {"primaryColor": "#f00"}}}%%\nflowchart LR\nA',
      "---\ntitle: url(example)\nconfig:\n  theme: forest\n  flowchart:\n    nodeSpacing: 40\n---\nflowchart LR\nA",
    ])
      expect(mermaidSourceConfigFetchRisk(source), source).toBeNull();
  });

  it("checks decoded JSON/YAML values and every override independently", () => {
    for (const source of [
      '%%{init: {"themeVariables": {"primaryColor": "\\u0075rl(x)"}}}%%\nflowchart LR\nA',
      '---\nconfig:\n  themeVariables:\n    primaryColor: "\\u0075rl(x)"\n---\nflowchart LR\nA',
      '%%{init: {"themeCSS": ".node{fill:red}"}}%%\n%%{init: {"theme": "forest"}}%%\nflowchart LR\nA',
      "---\nconfig:\n  fontFamily: Inter\n---\nflowchart LR\nA",
      "---\nconfig: unsupported\n---\nflowchart LR\nA",
      "%%{init: not JSON}%%\nflowchart LR\nA",
      "---\nconfig: [\n---\nflowchart LR\nA",
    ])
      expect(mermaidSourceConfigFetchRisk(source), source).not.toBeNull();
  });

  it("bounds nested configuration inspection, including cycles", () => {
    const cyclic: { child?: unknown } = {};
    cyclic.child = cyclic;
    expect(mermaidConfigFetchRisk({ themeVariables: cyclic })).not.toBeNull();
    expect(mermaidConfigFetchRisk({ themeVariables: { a: { b: { c: {} } } } })).not.toBeNull();
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
