import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import "../../index.css";
import { MermaidDiagramCard } from "./MermaidDiagramCard";
import { mermaidSvgToPngBlob, prepareSvgForExport } from "./mermaidExport";

const cases = [
  {
    name: "tall state",
    source: "stateDiagram-v2\n[*] --> Still\nStill --> Moving\nMoving --> [*]",
    label: "Moving",
    narrow: true,
  },
  {
    name: "tall RTL",
    source: [
      "flowchart TD",
      'A["איסוף נתונים"] --> B["בקרת איכות"]',
      'B --> C["ניתוח"]',
      'C --> D["תוצאה"]',
      'D --> E["כתיבת המאמר"]',
    ].join("\n"),
    label: "איסוף נתונים",
    narrow: true,
  },
  {
    name: "wide flow",
    source: [
      "flowchart LR",
      'A["Collect research samples"] --> B["Validate all measurements"]',
      'B --> C["Analyze experimental observations"]',
      'C --> D["Review scientific results"]',
      'D --> E["Publish the manuscript"]',
    ].join("\n"),
    label: "Analyze experimental observations",
    narrow: false,
  },
  {
    name: "math labels",
    source: 'flowchart LR\nA["$$\\frac{1}{2}$$"] --> B["$$\\sqrt{2} + \\mathbf{x}$$"]',
    label: "2",
    narrow: true,
  },
] as const;

const appearances = ["light", "dark"] as const;

function contentWidth(element: HTMLElement) {
  const style = getComputedStyle(element);
  return (
    element.clientWidth -
    Number.parseFloat(style.paddingLeft) -
    Number.parseFloat(style.paddingRight)
  );
}

describe("actual Pele inline sizing", () => {
  it.each(cases.flatMap((fixture) => appearances.map((theme) => ({ ...fixture, theme }))))(
    "preserves $name intrinsic size and shrinks to fit in $theme",
    async ({ source, label, narrow, theme, name }) => {
      const container = document.createElement("div");
      container.style.width = "800px";
      await using screen = await render(
        <MermaidDiagramCard source={source} language="mermaid" title={name} theme={theme} />,
        { container, router: false },
      );
      await vi.waitFor(() =>
        expect(screen.container.querySelector(".scient-mermaid-inline svg")).not.toBeNull(),
      );
      const stage = screen.container.querySelector<HTMLElement>(".scient-mermaid-inline")!;
      const svg = stage.querySelector<SVGSVGElement>("svg")!;
      const originalSvg = svg.outerHTML;
      const originalCopy = screen.container
        .querySelector("[data-markdown-copy]")
        ?.getAttribute("data-markdown-copy");
      expect(originalCopy).toContain(source);
      const natural = svg.viewBox.baseVal;
      expect(natural.width).toBeGreaterThan(0);
      expect(natural.height).toBeGreaterThan(0);
      expect(svg.textContent?.replace(/\s+/gu, "")).toContain(label.replace(/\s+/gu, ""));
      if (name === "math labels") {
        expect(svg.querySelector("math mfrac")).not.toBeNull();
        expect(svg.querySelector("math msqrt")).not.toBeNull();
      }
      if (narrow) expect(natural.width).toBeLessThan(contentWidth(stage));
      else expect(natural.width).toBeGreaterThan(contentWidth(stage));

      for (const width of [800, 240, 800]) {
        container.style.width = `${width}px`;
        const available = contentWidth(stage);
        const expected = Math.min(natural.width, available);
        const bounds = svg.getBoundingClientRect();
        expect(bounds.width).toBeCloseTo(expected, 0);
        expect(bounds.height).toBeCloseTo((expected * natural.height) / natural.width, 0);
        expect(stage.scrollWidth).toBeLessThanOrEqual(stage.clientWidth + 1);
        const center = stage.getBoundingClientRect().left + stage.clientWidth / 2;
        expect(bounds.left + bounds.width / 2).toBeCloseTo(center, 0);
        expect(svg.outerHTML).toBe(originalSvg);
        expect(
          screen.container
            .querySelector("[data-markdown-copy]")
            ?.getAttribute("data-markdown-copy"),
        ).toBe(originalCopy);
      }
    },
  );

  it.each(appearances)(
    "preserves actual-size zoom, MathML and intrinsic PNG export in %s",
    async (theme) => {
      const source = cases[3].source;
      const container = document.createElement("div");
      container.style.width = "240px";
      await using screen = await render(
        <MermaidDiagramCard
          source={source}
          language="mermaid"
          title="Measured math"
          theme={theme}
        />,
        { container, router: false },
      );
      await vi.waitFor(() =>
        expect(screen.container.querySelector(".scient-mermaid-inline svg")).not.toBeNull(),
      );
      const inline = screen.container.querySelector<SVGSVGElement>(".scient-mermaid-inline svg")!;
      const original = inline.outerHTML;
      const natural = {
        width: inline.viewBox.baseVal.width,
        height: inline.viewBox.baseVal.height,
      };
      await screen.getByRole("button", { name: "Expand diagram", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Measured math" });
      await expect.element(dialog).toBeVisible();
      await dialog.getByRole("button", { name: "Actual size", exact: true }).click();
      const expanded = document.querySelector<SVGSVGElement>(".scient-mermaid-dialog-diagram svg")!;
      await vi.waitFor(() =>
        expect(expanded.getBoundingClientRect().width).toBeCloseTo(natural.width, 0),
      );
      await dialog.getByRole("button", { name: "Zoom in", exact: true }).click();
      await vi.waitFor(() =>
        expect(expanded.getBoundingClientRect().width).toBeCloseTo(
          Math.round(natural.width * 1.25),
          0,
        ),
      );
      expect(expanded.outerHTML).toBe(original);
      expect(expanded.querySelector("math mfrac")).not.toBeNull();
      await dialog.getByRole("button", { name: "Fit diagram to window", exact: true }).click();
      const stage = document.querySelector<HTMLElement>(".scient-mermaid-dialog-stage")!;
      await vi.waitFor(() =>
        expect(expanded.getBoundingClientRect().width).toBeCloseTo(contentWidth(stage), 0),
      );

      const exported = new DOMParser().parseFromString(
        prepareSvgForExport(original, theme),
        "image/svg+xml",
      );
      expect(exported.querySelector("parsererror")).toBeNull();
      expect(exported.documentElement.getAttribute("viewBox")).toBe(inline.getAttribute("viewBox"));
      expect(exported.querySelector("math mfrac")).not.toBeNull();
      const png = await mermaidSvgToPngBlob(original, theme);
      const bytes = new Uint8Array(await png.arrayBuffer());
      expect(Array.from(bytes.subarray(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
      const header = new DataView(bytes.buffer);
      expect(header.getUint32(16)).toBe(Math.round(natural.width * 2));
      expect(header.getUint32(20)).toBe(Math.round(natural.height * 2));
      expect(inline.outerHTML).toBe(original);
    },
  );
});
