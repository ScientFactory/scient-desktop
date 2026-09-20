// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vite-plus/test";
import { captureVisualPresentationAnchor } from "./visualPresentationAnchor";

afterEach(() => vi.restoreAllMocks());
function surface(text: string, top: number) {
  const container = document.createElement("div");
  const layer = document.createElement("div");
  layer.className = "textLayer";
  const span = document.createElement("span");
  span.textContent = text;
  layer.append(span);
  container.append(layer);
  vi.spyOn(container, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 600, 600));
  vi.spyOn(span, "getBoundingClientRect").mockReturnValue(new DOMRect(0, top, 300, 12));
  return { container, span };
}
it("anchors a logical prose position through an insertion before the visible line", () => {
  const old = surface("Visible second line", 80);
  const next = surface("Visible second line", 104);
  vi.spyOn(Range.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 104, 7, 12));
  const anchor = captureVisualPresentationAnchor(
    old.container,
    "First line. Visible second line",
    "New first line expanded. Visible second line",
  );
  expect(anchor?.screenTop).toBe(80);
  expect(anchor?.locate(next.container)).toBe(104);
  // The stable line position, not caret X, is what gets compensated.
  expect(anchor?.key).toContain("Visiblesecondline");
});
it("refuses ambiguous text rather than moving the page toward an arbitrary occurrence", () => {
  const old = surface("Repeated text", 80);
  expect(
    captureVisualPresentationAnchor(
      old.container,
      "Repeated text. Repeated text",
      "Repeated text. Repeated text",
    ),
  ).toBeNull();
});
it("falls back without movement when the replacement has no rendered match", () => {
  const old = surface("Visible line", 80);
  const anchor = captureVisualPresentationAnchor(old.container, "Visible line", "Visible new line");
  expect(anchor?.locate(document.createElement("div"))).toBeNull();
});

it("locates nearby repagination from compiled text without admitting ambiguous page matches", async () => {
  const old = surface("Visible line with enough text to identify its position", 80);
  const anchor = captureVisualPresentationAnchor(
    old.container,
    old.span.textContent!,
    old.span.textContent!,
  );
  const document = {
    numPages: 3,
    getPage: async (page: number) => ({
      getTextContent: async () => ({
        items: [{ str: page === 2 ? old.span.textContent! : "other text" }],
      }),
    }),
  } as Parameters<NonNullable<NonNullable<typeof anchor>["locatePage"]>>[0];
  expect(await anchor?.locatePage?.(document, new AbortController().signal)).toBe(2);
  document.getPage = async () =>
    ({ getTextContent: async () => ({ items: [{ str: old.span.textContent! }] }) }) as Awaited<
      ReturnType<typeof document.getPage>
    >;
  expect(await anchor?.locatePage?.(document, new AbortController().signal)).toBeNull();
});
