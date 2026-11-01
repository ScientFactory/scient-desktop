import { EnvironmentId } from "@t3tools/contracts";
import type { PdfSourceResolver } from "@scientfactory/document-artifacts";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { act, render } from "../../../test/render";
import { ScientPdfReader } from "./ScientPdfReader";
import { workspacePdfSource } from "./pdfSource";
import "~/index.css";

// The incoming preview fixture exercises mixed media boxes, rotated text and a split-span find.
function planningPdf(): Blob {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Count 3 /Kids [3 0 R 5 0 R 7 0 R] >>",
  ];
  for (const [index, title] of [
    "Quarterly outlook",
    "Delivery milestones",
    "Budget and risks",
  ].entries()) {
    const text = `/GS1 gs BT /F1 24 Tf 30 ${index === 0 ? 70 : 700} Td ${index === 0 ? "(Quarter) Tj /F2 24 Tf (ly outlook) Tj" : `(${title}) Tj`} ET`;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 ${index === 0 ? 140 : 792}] /Rotate ${index === 2 ? 90 : 0} /Resources << /Font << /F1 9 0 R /F2 10 0 R >> /ExtGState << /GS1 << /TR << /FunctionType 2 /Domain [0 1] /C0 [0] /C1 [1] /N 2 >> >> >> >> /Contents ${4 + index * 2} 0 R >>`,
      `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
    );
  }
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>");
  let source = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(source.length);
    source += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = source.length;
  source += `xref\n0 11\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("")}trailer\n<< /Size 11 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;

  return new Blob([source], { type: "application/pdf" });
}

it("renders, resizes, searches and selects the incoming mixed-page document in Scient's real reader", async () => {
  await page.viewport(1200, 850);
  const url = URL.createObjectURL(planningPdf());
  try {
    const source = workspacePdfSource({
      environmentId: EnvironmentId.make("synthetic-pdf-rendering"),
      workspaceRoot: "/synthetic",
      relativePath: "planning.pdf",
      fileName: "Planning.pdf",
    });
    const resolver: PdfSourceResolver = {
      useResolve: () => ({
        _tag: "Success",
        url,
        expiresAt: Number.MAX_SAFE_INTEGER,
        refresh: () => {},
      }),
    };
    await using screen = await render(
      <div style={{ display: "flex", height: 650, width: 700 }}>
        <ScientPdfReader source={source} resolver={resolver} readerScope="alignment-real-pdf" />
      </div>,
    );
    const container = () =>
      screen.container.querySelector<HTMLElement>(".scient-pdf-viewer-container")!;
    await vi.waitFor(
      () => {
        expect(container()?.querySelector('.page[data-page-number="1"] canvas')).not.toBeNull();
        expect(screen.container.querySelector('span[aria-label="3 pages"]')).not.toBeNull();
        expect(screen.container.textContent).toContain("Quarter");
      },
      { timeout: 15_000 },
    );
    const firstWidth = container().querySelector("canvas")!.getBoundingClientRect().width;
    await act(() => {
      (screen.container.firstElementChild as HTMLElement).style.width = "900px";
    });
    await vi.waitFor(() =>
      expect(container().querySelector("canvas")!.getBoundingClientRect().width).toBeGreaterThan(
        firstWidth,
      ),
    );
    await screen.getByRole("button", { name: /^Next page/ }).click();
    await vi.waitFor(() =>
      expect(
        (screen.container.querySelector('input[aria-label="Page number"]') as HTMLInputElement)
          .value,
      ).toBe("2"),
    );
    await screen.getByRole("button", { name: /^Previous page/ }).click();
    await vi.waitFor(() =>
      expect(
        (screen.container.querySelector('input[aria-label="Page number"]') as HTMLInputElement)
          .value,
      ).toBe("1"),
    );
    const search = screen.getByRole("textbox", { name: "Search PDF" });
    await search.fill("Quarterly outlook");
    await vi.waitFor(() => {
      expect(screen.container.querySelector(".scient-reader-search-count")?.textContent).toBe(
        "1/1",
      );
      expect(
        [...container().querySelectorAll(".textLayer .highlight")]
          .map((node) => node.textContent)
          .join(""),
      ).toBe("Quarterly outlook");
    });
    await search.fill("Budget");
    await vi.waitFor(() =>
      expect(
        (screen.container.querySelector('input[aria-label="Page number"]') as HTMLInputElement)
          .value,
      ).toBe("3"),
    );
    await screen.getByRole("button", { name: /^Zoom in/ }).click();
    await vi.waitFor(() => {
      const span = [
        ...container().querySelectorAll<HTMLElement>('.page[data-page-number="3"] .textLayer span'),
      ].find((node) => node.textContent === "Budget and risks");
      expect(span).toBeDefined();
      const bounds = span!.getBoundingClientRect(),
        pageBounds = span!.closest(".page")!.getBoundingClientRect();
      expect(bounds.width).toBeGreaterThan(0);
      expect(bounds.height).toBeGreaterThan(0);
      expect(bounds.left).toBeGreaterThanOrEqual(pageBounds.left - 1);
      expect(bounds.top).toBeGreaterThanOrEqual(pageBounds.top - 1);
      expect(bounds.right).toBeLessThanOrEqual(pageBounds.right + 1);
      expect(bounds.bottom).toBeLessThanOrEqual(pageBounds.bottom + 1);
      const range = document.createRange();
      range.selectNodeContents(span!);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      expect(selection.toString()).toBe("Budget and risks");
      expect(getComputedStyle(span!).userSelect).not.toBe("none");
      selection.removeAllRanges();
    });
    await screen.getByRole("button", { name: /^Fit width, zoom/ }).click();
    await search.fill("");
    await vi.waitFor(() => {
      expect(screen.container.querySelector(".scient-reader-search-count")).toBeNull();
      expect(container().querySelectorAll(".textLayer .highlight")).toHaveLength(0);
    });
    expect(
      (screen.container.querySelector('input[aria-label="Page number"]') as HTMLInputElement).value,
    ).toBe("3");
  } finally {
    URL.revokeObjectURL(url);
  }
});
