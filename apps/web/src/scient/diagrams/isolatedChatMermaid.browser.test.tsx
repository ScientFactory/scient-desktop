import { render, stubGlobal } from "../../../test/render";
import "../../index.css";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { MermaidDiagramCard } from "./MermaidDiagramCard";
import { mermaidSvgToPngBlob } from "./mermaidExport";
import { renderMermaidDiagram } from "./mermaidRuntime";
import { recoveryFixtures } from "./mermaidRecovery.fixtures";
import { stripSvgExternalResources } from "./svgExternalResources";

const PROBE = "__scient_chat_diagram_probe__";
const probeRequests = () =>
  (performance.getEntriesByType("resource") as PerformanceResourceTiming[])
    .filter((entry) => entry.name.includes(PROBE))
    .map((entry) => entry.name);

const FETCHING = [
  {
    name: "label image",
    source: `flowchart LR\nA["<img src='/${PROBE}/label.png'>"] --> B`,
    address: `/${PROBE}/label.png`,
  },
  {
    name: "remote label image",
    source: `flowchart LR\nA["<img src='https://example.invalid/${PROBE}/pixel.png'>"] --> B`,
    address: `https://example.invalid/${PROBE}/pixel.png`,
  },
  {
    name: "image shape",
    source: `flowchart LR\nA@{ img: "/${PROBE}/shape.png", h: 40 } --> B`,
    address: `/${PROBE}/shape.png`,
  },
  {
    name: "sequence actor icon",
    source: `sequenceDiagram\nparticipant A\nproperties A: {"icon": "/${PROBE}/icon.png"}\nA->>A: hi`,
    address: `/${PROBE}/icon.png`,
  },
  {
    name: "; joined actor icon",
    source: `sequenceDiagram\nparticipant A;properties A: {"icon":"/${PROBE}/joined.png"}\nA->>A: hi`,
    address: `/${PROBE}/joined.png`,
  },
  {
    name: "label style url()",
    source: `flowchart LR\nA["<span style='background:url(/${PROBE}/span.png)'>x</span>"] --> B`,
    address: `/${PROBE}/span.png`,
  },
  {
    name: "classDef url()",
    source: `stateDiagram-v2\nclassDef c background-image:url(/${PROBE}/state.png)\n[*] --> A:::c`,
    address: `/${PROBE}/state.png`,
  },
  {
    name: "authored external font",
    source: `%%{init: {"themeCSS": "@font-face{font-family:ProbeFace;src:url(/${PROBE}/font.woff2)}", "fontFamily": "ProbeFace"}}%%\nflowchart LR\nA --> B`,
    address: `/${PROBE}/font.woff2`,
  },
];

/** SVG presentation attributes (and one unknown attribute) that load like CSS, in a label. */
const ATTRIBUTE_LOADS = [
  "mask",
  "filter",
  "clip-path",
  "fill",
  "stroke",
  "marker-start",
  "marker-mid",
  "marker-end",
  "cursor",
  "data-unknown",
].map((attribute) => ({
  name: `${attribute} attribute`,
  source: `flowchart LR\nA["<svg width='10' height='10'><path d='M0 0 L5 5 L10 0' ${attribute}='url(/${PROBE}/${attribute}.png)'/></svg>"] --> B`,
  address: `/${PROBE}/${attribute}.png`,
}));
const HTML_ATTRIBUTE_LOADS = [
  {
    name: "HTML background attribute",
    source: `flowchart LR\nA["<table background='/${PROBE}/table.png'><tr><td>x</td></tr></table>"] --> B`,
    address: `/${PROBE}/table.png`,
  },
  {
    name: "escaped mask attribute",
    source: `flowchart LR\nA["<svg width='10' height='10'><rect width='10' height='10' mask='u\\72l(/${PROBE}/escaped.png)'/></svg>"] --> B`,
    address: `/${PROBE}/escaped.png`,
  },
];

/** Ordinary diagrams across the common types, including math and theme directives. */
const ORDINARY = [
  "flowchart TD\nA[Start] --> B{Is it?}\nB -->|Yes| C[OK]\nB -->|No| D[Try again with a longer label]",
  "sequenceDiagram\nAlice->>Bob: Hello Bob, how are you?\nBob-->>Alice: Fine, thanks",
  "classDiagram\nclass Animal {\n  +String name\n  +eat() void\n}\nAnimal <|-- Duck",
  "stateDiagram-v2\n[*] --> Still\nStill --> Moving\nMoving --> [*]",
  "erDiagram\nCUSTOMER ||--o{ ORDER : places",
  'pie title Pets\n"Dogs" : 386\n"Cats" : 85',
  'flowchart LR\nA["$$\\frac{1}{2}$$"] --> B["**bold** and `code`"]',
  "%%{init: {'theme': 'forest'}}%%\nflowchart LR\nA --> B",
  'flowchart LR\nA["<b>bold</b><br>two lines"] --> B',
  `flowchart LR\nA["icon: 'https://example.org/reference'"] --> B`,
  `flowchart LR\n%% A@{ img: 'https://example.org/reference' }\nA["favicon: 'https://example.org/reference'"] --> B`,
];

describe("live upstream renderer safety and product behavior", () => {
  it("calibrates resource observation using an ordinary page-owned request", async () => {
    // Vitest's dependency requests can fill Chromium's bounded timing buffer.
    performance.clearResourceTimings();
    const address = `/${PROBE}/control.png`;
    const image = new Image();
    image.src = address;
    await image.decode().catch(() => undefined);
    await vi.waitFor(() => expect(probeRequests().some((url) => url.endsWith(address))).toBe(true));
  });

  it.each([...FETCHING, ...ATTRIBUTE_LOADS, ...HTML_ATTRIBUTE_LOADS])(
    "renders $name inertly and preserves its blocked-resource notice",
    async ({ source, address }) => {
      const before = probeRequests().filter((url) => url.includes(address));
      const result = await renderMermaidDiagram(source, "light");
      expect(result.svg).not.toContain(PROBE);
      expect(result.blocked).toContain(address);
      await using screen = await render(<div dangerouslySetInnerHTML={{ __html: result.svg }} />, {
        router: false,
      });
      expect(screen.container.querySelector("svg")).not.toBeNull();
      expect(screen.container.querySelector("image, img, a, script, style, [onclick]")).toBeNull();
      expect((await mermaidSvgToPngBlob(result.svg, "light")).type).toBe("image/png");
      expect(probeRequests().filter((url) => url.includes(address))).toEqual(before);
    },
  );

  it.each(["light", "dark"] as const)(
    "renders ordinary %s diagrams without resource notices",
    async (theme) => {
      for (const source of ORDINARY) {
        const result = await renderMermaidDiagram(source, theme);
        expect(result.blocked, source).toBeUndefined();
        expect(result.svg).toContain("<svg");
        expect((await mermaidSvgToPngBlob(result.svg, theme)).type).toBe("image/png");
      }
    },
  );

  it.each(recoveryFixtures)("ports the immutable recovery condition: $name", async (fixture) => {
    const result = await renderMermaidDiagram(fixture.source, "light");
    expect(result.recovery?.originalSource).toBe(fixture.source);
    expect(result.recovery?.source).toBe(fixture.expected);
    expect(result.svg).toContain("<svg");
  });

  it("keeps generated MathML, spaced labels and native PNG export after fonts load", async () => {
    await document.fonts.ready;
    const { svg } = await renderMermaidDiagram(
      "sequenceDiagram\nAlice->>Bob: $$\\frac{d}{dx}\\mathbf{v} + \\sqrt{2} + \\text{total cost}$$",
      "light",
    );
    await using screen = await render(<div dangerouslySetInnerHTML={{ __html: svg }} />, {
      router: false,
    });
    const math = screen.container.querySelector("math");
    expect(math?.namespaceURI).toBe("http://www.w3.org/1998/Math/MathML");
    expect(math?.querySelector("mfrac")?.textContent).toContain("d");
    expect(math?.querySelector("msqrt")?.textContent).toBe("2");
    expect(math?.textContent).toContain("total");
    expect(math?.querySelector("annotation, annotation-xml, mglyph")).toBeNull();
    expect((await mermaidSvgToPngBlob(svg, "light")).type).toBe("image/png");
    expect(document.querySelector('[style*="left: -9999px"]')).toBeNull();
  });

  it("keeps hostile authored MathML, TeX commands and diagram callbacks inert", async () => {
    const callback = vi.fn();
    using _callback = stubGlobal("scientDiagramCallback", callback);
    const source = [
      '%%{init: {"securityLevel":"loose","startOnLoad":true}}%%',
      "flowchart LR",
      "A[\"Authored callback target\"] --> B[\"<math href='javascript:alert(1)'><mi onclick='alert(1)'>x</mi><annotation-xml><img src='https://example.invalid/evil.png'></annotation-xml></math>\"]",
      "click A scientDiagramCallback",
      'C["$$\\href{javascript:alert(1)}{x} + \\includegraphics{https://example.invalid/math.png}$$"]',
    ].join("\n");
    await using screen = await render(
      <MermaidDiagramCard source={source} language="mermaid" title={null} theme="light" />,
      { router: false },
    );
    await vi.waitFor(() =>
      expect(screen.container.querySelector(".scient-mermaid-inline svg")).not.toBeNull(),
    );
    const svg = screen.container.querySelector(".scient-mermaid-inline svg")!;
    expect(
      svg.querySelector(
        "a, img, image, script, style, annotation-xml, mglyph, [onclick], [onerror], [href]",
      ),
    ).toBeNull();
    const target = [...svg.querySelectorAll(".pele-node")].find(
      (node) => node.querySelector(".pele-label")?.textContent === "Authored callback target",
    );
    expect(target, "The authored A node must be present, not just an SVG root").toBeDefined();
    const clicked = vi.fn();
    target!.addEventListener("click", clicked);
    try {
      callback();
      expect(callback).toHaveBeenCalledOnce();
      callback.mockClear();
      await userEvent.click(page.elementLocator(target!));
      expect(clicked).toHaveBeenCalledOnce();
      const event = clicked.mock.calls[0]![0] as MouseEvent;
      expect(event.isTrusted).toBe(true);
      expect(target!.contains(event.target as Node)).toBe(true);
      expect(callback).not.toHaveBeenCalled();
    } finally {
      target!.removeEventListener("click", clicked);
    }
    expect(callback).not.toHaveBeenCalled();
    const unrelated = document.createElement("pre");
    unrelated.className = "mermaid";
    unrelated.textContent = "flowchart LR\nUnrelated --> Source";
    screen.container.append(unrelated);
    expect(unrelated.querySelector("svg")).toBeNull();
  });

  it("shows explicit blocked web links and keeps responsive SVG and dialog export inputs stable", async () => {
    const source = FETCHING[1]!.source;
    await using screen = await render(
      <MermaidDiagramCard source={source} language="mermaid" title="Study" theme="light" />,
      { router: false },
    );
    await vi.waitFor(() =>
      expect(screen.container.querySelector('[role="note"]')?.textContent).toContain(
        "Outside content not loaded",
      ),
    );
    const link = screen.container.querySelector<HTMLAnchorElement>('[role="note"] a');
    expect(link?.getAttribute("href")).toBe(FETCHING[1]!.address);
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("rel")).toBe("noopener noreferrer");
    const svg = screen.container.querySelector<SVGSVGElement>(".scient-mermaid-inline svg")!;
    const original = svg.outerHTML;
    screen.container.style.width = "400px";
    expect(svg.getBoundingClientRect().width).toBeLessThanOrEqual(400);
    screen.container.style.width = "240px";
    expect(svg.getBoundingClientRect().width).toBeLessThanOrEqual(240);
    expect(svg.outerHTML).toBe(original);
    await screen.getByRole("button", { name: "Expand diagram", exact: true }).click();
    await vi.waitFor(() =>
      expect(document.querySelector(".scient-mermaid-dialog-diagram svg")).not.toBeNull(),
    );
    expect(document.querySelector(".scient-mermaid-dialog-diagram svg")?.outerHTML).toBe(original);
  });
});

describe("stripping outside loads from a drawn SVG", () => {
  const svg = (body: string) =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><style>#d .node{fill:red}</style>${body}</svg>`;

  it("leaves an SVG with nothing to load byte for byte", async () => {
    const plain = svg(
      '<a href="https://example.org"><g style="fill:url(#grad)"><text>hi</text></g></a>',
    );
    expect(stripSvgExternalResources(plain)).toEqual({ svg: plain, blocked: [] });
  });

  it("removes every kind of outside load and names each address", async () => {
    const { svg: stripped, blocked } = stripSvgExternalResources(
      svg(
        [
          '<image href="https://a.example/1.png"/>',
          '<use href="https://a.example/sprite.svg#x"/>',
          '<g style="fill:red;background:u\\72l(https://a.example/2.png)"><text>kept</text></g>',
          '<style>@import url(https://a.example/3.css); .x{background-image:image-set("https://a.example/4.png" 1x)} .y{fill:blue}</style>',
          '<foreignObject><div xmlns="http://www.w3.org/1999/xhtml"><picture><source srcset="/\\a.example/5.png 2x"/><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw="/></picture></div></foreignObject>',
          '<g onclick="alert(1)"><text>also kept</text></g>',
        ].join(""),
      ),
    );
    expect(blocked).toEqual(
      expect.arrayContaining([
        "https://a.example/1.png",
        "https://a.example/sprite.svg#x",
        "https://a.example/2.png",
        "https://a.example/3.css",
        "https://a.example/4.png",
        "/\\a.example/5.png",
      ]),
    );
    expect(stripped).not.toContain("a.example");
    expect(stripped).not.toContain("onclick");
    expect(stripped).toContain("kept");
    expect(stripped).toContain("also kept");
    expect(stripped).toContain("fill: blue");
    // A picture drawn from data: stays.
    expect(stripped).toContain("data:image/gif");
  });

  it("drops every attribute whose value loads like CSS, and animations that set a link", async () => {
    const { svg: stripped, blocked } = stripSvgExternalResources(
      svg(
        [
          '<path d="M0 0" mask="url(https://a.example/m.png?s=v)" fill="url(#local)"/>',
          '<rect filter="url(\'https://a.example/f.svg#x\')" clip-path="url(https://a.example/c.svg#c)"/>',
          '<line stroke="url(https://a.example/s.svg#g)" marker-start="url(https://a.example/ms.svg#m)" marker-mid="url(https://a.example/mm.svg#m)" marker-end="url(https://a.example/me.svg#m)"/>',
          '<g cursor="url(https://a.example/cur.png), auto" data-whatever="url(https://a.example/u.png"/>',
          '<a href="#top"><set attributeName="href" to="https://a.example/anim.png"/></a>',
        ].join(""),
      ),
    );
    expect(stripped).not.toContain("a.example");
    expect(stripped).toContain('fill="url(#local)"');
    expect(blocked).toEqual(
      expect.arrayContaining([
        "https://a.example/m.png?s=v",
        "https://a.example/f.svg#x",
        "https://a.example/c.svg#c",
        "https://a.example/s.svg#g",
        "https://a.example/ms.svg#m",
        "https://a.example/mm.svg#m",
        "https://a.example/me.svg#m",
        "https://a.example/cur.png",
        "https://a.example/u.png",
        "https://a.example/anim.png",
      ]),
    );
  });
});
