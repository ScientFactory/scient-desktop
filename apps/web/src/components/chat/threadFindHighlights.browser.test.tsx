import { describe, expect, it, vi } from "vite-plus/test";
import { render } from "../../../test/render";
import { collectThreadFindRanges, useThreadFindHighlights } from "./threadFindHighlights";
function Probe(props: Parameters<typeof useThreadFindHighlights>[0]) {
  useThreadFindHighlights(props);
  return null;
}
const activeRanges = () => [
  ...(CSS.highlights.get("t3-thread-find-active") as unknown as Set<Range>),
];

function setup() {
  using stack = new DisposableStack();
  const highlights = ["t3-thread-find", "t3-thread-find-active"].map(
    (name) => [name, CSS.highlights.get(name)] as const,
  );
  stack.defer(() => {
    for (const [name, highlight] of highlights) {
      if (highlight) CSS.highlights.set(name, highlight);
      else CSS.highlights.delete(name);
    }
  });
  const container = document.createElement("div");
  container.innerHTML =
    '<div data-timeline-row-id="first"><p data-thread-find-text>COD4 and COD4</p></div>' +
    '<div data-timeline-row-id="second"><p data-thread-find-text>COD4</p></div>';
  document.body.append(container);
  stack.defer(() => container.remove());
  const environment = stack.move();
  return {
    container,
    onActiveRange: vi.fn(),
    [Symbol.dispose]: () => environment.dispose(),
  };
}
describe("find highlight caching", () => {
  it("checks only the old and new occurrence when cycling thousands of cached matches", async () => {
    using find = setup();
    const { container, onActiveRange } = find;
    container.innerHTML =
      '<div data-timeline-row-id="first"><div data-thread-find-fold><p data-thread-find-text>' +
      "COD4 ".repeat(1500) +
      "</p></div></div>";
    using bounds = vi.spyOn(Range.prototype, "getBoundingClientRect");
    container.style.width = "800px";
    const fold = container.querySelector<HTMLElement>("[data-thread-find-fold]")!;
    fold.style.cssText = "height:100px;overflow:hidden;white-space:nowrap";
    expect(fold.getBoundingClientRect().height).toBe(100);
    const props = {
      container,
      query: "COD4",
      activeRowId: "first",
      activeOccurrence: 0,
      onActiveRange,
    };
    await using screen = await render(<Probe {...props} />);
    const inactive = CSS.highlights.get("t3-thread-find");
    const first = activeRanges()[0];
    bounds.mockClear();
    await screen.rerender(<Probe {...props} activeOccurrence={1} />);
    expect(bounds).toHaveBeenCalledTimes(2);
    expect(CSS.highlights.get("t3-thread-find")).toBe(inactive);
    expect(inactive?.size).toBe(1499);
    expect(inactive?.has(first!)).toBe(true);
    expect(activeRanges()[0]?.startOffset).toBe(5);
    expect(inactive?.has(activeRanges()[0]!)).toBe(false);
  });
});
function row(html: string) {
  const container = document.createElement("div");
  container.innerHTML = `<div data-timeline-row-id="row"><div data-thread-find-text>${html}</div></div>`;
  return container;
}
describe("collectThreadFindRanges", () => {
  it("finds matches split across inline token spans, in order", () => {
    // Shiki-style tokens split one identifier over several text nodes.
    const container = row(
      "<pre><code><span>con</span><span>st</span> a = <span>c</span>onst; const</code></pre>",
    );
    const ranges = collectThreadFindRanges(container, "const");
    expect(ranges.map((match) => [match.occurrence, match.range.toString()])).toEqual([
      [0, "const"],
      [1, "const"],
      [2, "const"],
    ]);
  });
});
