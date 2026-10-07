/**
 * Chat diagrams against the real Mermaid, in a real browser, with the app's stylesheet: a
 * diagram that names an outside resource draws without it, says what it left out, and makes
 * no request at all, while ordinary diagrams draw exactly as they did in the page.
 */
import "../../index.css";

import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { sharedIsolatedMermaid } from "./isolatedMermaid";
import { MermaidDiagramCard } from "./MermaidDiagramCard";
import { mermaidSvgToPngBlob } from "./mermaidExport";
import { renderMermaidDiagram, type MermaidTheme } from "./mermaidRuntime";
import { stripSvgExternalResources } from "./svgExternalResources";

const PROBE = "__scient_chat_diagram_probe__";

/**
 * Probe loads that reached the server. Chromium also lists loads its policy refused, but
 * those never get a response: no status and no response time.
 */
const probeRequests = (target: Window = window) =>
  (target.performance.getEntriesByType("resource") as PerformanceResourceTiming[])
    .filter((entry) => entry.name.includes(PROBE))
    .filter((entry) => entry.responseStatus !== 0 || entry.responseStart > 0)
    .map((entry) => entry.name);

const allProbeRequests = async () => [
  ...probeRequests(),
  ...probeRequests((await sharedIsolatedMermaid()).window),
];

let sentinels = 0;
/**
 * Lets any load a draw or a display started reach the resource timeline: waits a moment,
 * then for a fresh request of its own to be answered, so a slow machine cannot hide one.
 */
const settle = async () => {
  await new Promise((resolve) => setTimeout(resolve, 300));
  sentinels += 1;
  const sentinel = `/__scient_timeline_sentinel__/${sentinels}.png`;
  new Image().src = sentinel;
  await expect
    .poll(
      () =>
        (performance.getEntriesByType("resource") as PerformanceResourceTiming[]).some(
          (entry) => entry.name.endsWith(sentinel) && entry.responseStart > 0,
        ),
      { timeout: 10_000 },
    )
    .toBe(true);
};

/** Diagrams whose draw asks the browser to load something, with the address each names. */
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
];

/**
 * Ids differ between any two draws, and the classic look's shape outlines are drawn with
 * random control points; everything else, including every size and position, must match.
 */
const withoutIds = (svg: string) =>
  svg
    .replace(/scient-(?:chat-diagram|render|instance)-[0-9a-z]+(?:-[0-9a-z]+)?/gu, "ID")
    .replace(/ d="[^"]*"/gu, ' d=""');

let root: Root | undefined;
let host: HTMLDivElement | undefined;

// A dev-served page loads hundreds of modules; keep room for the probes behind them.
performance.setResourceTimingBufferSize(100_000);

afterEach(() => {
  root?.unmount();
  host?.remove();
  root = undefined;
  host = undefined;
  performance.clearResourceTimings();
});

describe("chat diagrams draw with no network access", () => {
  it("records a request to the probe, so an absent one means nothing was fetched", async () => {
    const image = new Image();
    image.src = `/${PROBE}/control.png`;
    await expect.poll(() => probeRequests(), { timeout: 10_000 }).toHaveLength(1);
  });

  it("measures the first draw, which opens the frame, against the page's first draw", async () => {
    const start = performance.now();
    await renderMermaidDiagram("flowchart LR\nFirst --> Frame", "light");
    const frameFirst = Math.round(performance.now() - start);
    const pageStart = performance.now();
    await renderMermaidDiagram("flowchart LR\nFirst --> Page", "light", "page");
    const pageFirst = Math.round(performance.now() - pageStart);
    const warmStart = performance.now();
    await renderMermaidDiagram("flowchart LR\nSecond --> Frame", "light");
    const frameWarm = Math.round(performance.now() - warmStart);
    console.log(
      `[scient-diagrams] first draw: frame ${frameFirst} ms (then ${frameWarm} ms), page ${pageFirst} ms`,
    );
    expect(frameFirst).toBeLessThan(20_000);
  });

  it.each(FETCHING)(
    "draws a $name without its outside load, names it, and requests nothing",
    async ({ source, address }) => {
      const rendered = await renderMermaidDiagram(source, "light");
      expect(rendered.diagramType).not.toBe("error");
      expect(rendered.svg).toContain("<svg");
      expect(rendered.svg).not.toContain(PROBE);
      expect(rendered.blocked?.some((blocked) => blocked.includes(address))).toBe(true);

      // Shown in the page as the card shows it.
      const shown = document.createElement("div");
      shown.innerHTML = rendered.svg;
      document.body.append(shown);
      await settle();
      shown.remove();
      expect(await allProbeRequests()).toEqual([]);

      // Copy PNG and Download PNG both rasterize this SVG.
      expect((await mermaidSvgToPngBlob(rendered.svg, "light")).type).toBe("image/png");
    },
  );

  it.each([...ATTRIBUTE_LOADS, ...HTML_ATTRIBUTE_LOADS])(
    "drops a $name, names it, and requests nothing in the frame or the page",
    async ({ source, address }) => {
      // What Mermaid itself kept, before Scient strips it.
      const raw = await (await sharedIsolatedMermaid()).render(source, { awaitRefusals: false });
      const rendered = await renderMermaidDiagram(source, "light");
      expect(rendered.svg).toContain("<svg");
      expect(rendered.svg).not.toContain(PROBE);
      if (raw.svg.includes(PROBE)) {
        expect(rendered.blocked?.some((blocked) => blocked.includes(address))).toBe(true);
      }
      const shown = document.createElement("div");
      shown.innerHTML = rendered.svg;
      document.body.append(shown);
      await settle();
      shown.remove();
      expect(await allProbeRequests()).toEqual([]);
    },
  );

  it("keeps Mermaid's own presentation attributes that load from outside for the check", async () => {
    // The attack the check exists for: Mermaid keeps a label's inline SVG attributes.
    const raw = await (
      await sharedIsolatedMermaid()
    ).render(ATTRIBUTE_LOADS[0]!.source, {
      awaitRefusals: false,
    });
    expect(raw.svg).toContain(`mask="url(/${PROBE}/mask.png)"`);
  });

  it("requests nothing once a card showing every kind of outside load is displayed", async () => {
    host = document.createElement("div");
    host.style.width = "720px";
    document.body.append(host);
    root = createRoot(host);
    const labels = [...ATTRIBUTE_LOADS, ...HTML_ATTRIBUTE_LOADS]
      .map(
        ({ source }, index) =>
          `N${index}${source.slice(source.indexOf("["), source.lastIndexOf("]") + 1)}`,
      )
      .join("\n");
    const source = `flowchart TD\n${labels}\nX["<img src='/${PROBE}/card.png'>"]`;
    root.render(
      <MermaidDiagramCard source={source} language="mermaid" title={null} theme="light" />,
    );
    await expect
      .poll(() => host!.querySelector(".scient-mermaid-inline svg") !== null, { timeout: 20_000 })
      .toBe(true);
    expect(host.querySelector('[role="note"]')?.textContent).toContain(`/${PROBE}/card.png`);
    await settle();
    expect(await allProbeRequests()).toEqual([]);
  });

  it("shows the card with a note that links each blocked web address", async () => {
    host = document.createElement("div");
    host.style.width = "720px";
    document.body.append(host);
    root = createRoot(host);
    const source = FETCHING[1]!.source;
    root.render(
      <MermaidDiagramCard source={source} language="mermaid" title={null} theme="light" />,
    );
    await expect
      .poll(() => host!.querySelector('[role="note"]')?.textContent ?? "", { timeout: 20_000 })
      .toContain("Outside content not loaded");
    const link = host.querySelector<HTMLAnchorElement>('[role="note"] a');
    expect(link?.getAttribute("href")).toBe(`https://example.invalid/${PROBE}/pixel.png`);
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(host.querySelector(".scient-mermaid-inline svg")).not.toBeNull();
    await settle();
    expect(await allProbeRequests()).toEqual([]);
  });

  it.each<MermaidTheme>(["light", "dark"])(
    "draws ordinary %s diagrams exactly as the page did, with no note",
    async (theme) => {
      for (const source of ORDINARY) {
        const isolated = await renderMermaidDiagram(source, theme);
        const page = await renderMermaidDiagram(source, theme, "page");
        expect(isolated.blocked, source).toBeUndefined();
        expect(withoutIds(isolated.svg), source).toBe(withoutIds(page.svg));
      }
    },
  );

  it("mirrors math styles and bundled fonts loaded after the frame opened", async () => {
    // The frame is open and has drawn; KaTeX's stylesheet and fonts arrive only now, as in chat.
    await renderMermaidDiagram("flowchart LR\nBefore --> Math", "light");
    const { renderScientTexToHtml } = await import("../math/katexRuntime");
    const math = document.createElement("div");
    math.innerHTML = renderScientTexToHtml("\\frac{a}{b} + \\beta", false) ?? "";
    document.body.append(math);
    await document.fonts.ready;
    await expect
      .poll(() => [...document.fonts].some((face) => face.status === "loaded"), {
        timeout: 10_000,
      })
      .toBe(true);
    for (const theme of ["light", "dark"] as const) {
      const source =
        'flowchart LR\nA["$$\\int_0^1 x^2\\,dx$$ and $$\\sqrt{2}$$"] --> B["$$\\alpha$$"]';
      const isolated = await renderMermaidDiagram(source, theme);
      const page = await renderMermaidDiagram(source, theme, "page");
      expect(withoutIds(isolated.svg), theme).toBe(withoutIds(page.svg));
    }
    const frameWindow = (await sharedIsolatedMermaid()).window;
    const frameFaces = [...frameWindow.document.fonts].map((face) => face.family);
    expect(frameFaces.some((family) => family.includes("KaTeX"))).toBe(true);
    math.remove();
  });

  it("lets the frame load only the app's own fonts, never another origin's", async () => {
    const frame = await sharedIsolatedMermaid();
    const policy = frame.window.document
      .querySelector('meta[http-equiv="Content-Security-Policy"]')
      ?.getAttribute("content");
    expect(policy).toContain("font-src 'self' data:");
    const otherUrl = new URL(window.location.origin);
    otherUrl.hostname = otherUrl.hostname === "localhost" ? "127.0.0.1" : "localhost";
    const otherOrigin = otherUrl.origin;
    expect(otherOrigin).not.toBe(window.location.origin);
    // A face from another origin is refused by the frame's policy before any request.
    const frameDocument = frame.window.document;
    const refusals: string[] = [];
    const onRefusal = (event: SecurityPolicyViolationEvent) =>
      refusals.push(event.effectiveDirective);
    frameDocument.addEventListener("securitypolicyviolation", onRefusal);
    const style = frameDocument.createElement("style");
    style.textContent = `@font-face{font-family:ProbeFace;src:url(${otherOrigin}/${PROBE}/font.woff2)}`;
    frameDocument.head.append(style);
    try {
      await frameDocument.fonts.load("16px ProbeFace").catch(() => []);
      await expect.poll(() => refusals, { timeout: 5_000 }).toContain("font-src");
    } finally {
      style.remove();
      frameDocument.removeEventListener("securitypolicyviolation", onRefusal);
    }
  });

  it("measures first-draw latency and a long thread's diagrams", async () => {
    const timed = async (run: () => Promise<unknown>) => {
      const start = performance.now();
      await run();
      return Math.round(performance.now() - start);
    };
    const thread = Array.from(
      { length: 60 },
      (_, index) => `flowchart LR\nA${index}[Step ${index}] --> B${index}[Result ${index}]`,
    );
    const frameThread = await timed(async () => {
      for (const source of thread) await renderMermaidDiagram(source, "light");
    });
    const pageThread = await timed(async () => {
      for (const source of thread) await renderMermaidDiagram(source, "light", "page");
    });
    const cached = await timed(async () => {
      for (const source of thread) await renderMermaidDiagram(source, "light");
    });
    console.log(
      `[scient-diagrams] 60 distinct diagrams: frame ${frameThread} ms, page ${pageThread} ms; cached ${cached} ms`,
    );
    // A generous bound catches a regression, not noise.
    expect(frameThread).toBeLessThan(pageThread * 3 + 2_000);
  });
});

describe("stripping outside loads from a drawn SVG", () => {
  const svg = (body: string) =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><style>#d .node{fill:red}</style>${body}</svg>`;

  it("leaves an SVG with nothing to load byte for byte", () => {
    const plain = svg(
      '<a href="https://example.org"><g style="fill:url(#grad)"><text>hi</text></g></a>',
    );
    expect(stripSvgExternalResources(plain)).toEqual({ svg: plain, blocked: [] });
  });

  it("removes every kind of outside load and names each address", () => {
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

  it("drops every attribute whose value loads like CSS, and animations that set a link", () => {
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
