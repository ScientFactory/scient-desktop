import { afterEach, describe, expect, it } from "vite-plus/test";
import { staticSourceSelection } from "./sourceCitation";

const mounted: HTMLElement[] = [];
afterEach(() => {
  document.getSelection()?.removeAllRanges();
  mounted.splice(0).forEach((root) => root.remove());
});

function sourceRows() {
  const root = document.createElement("div");
  document.body.append(root);
  mounted.push(root);
  const host = document.createElement("div");
  root.append(host);
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = `<div data-content>
    <div data-line="1"><span>const </span><span>alpha</span><span> = 1;</span></div>
    <div data-line="2"><span>const </span><span>beta</span><span> = 2;</span></div>
  </div>`;
  const words = shadow.querySelectorAll("[data-line] > span:nth-child(2)");
  return { root, alpha: words[0]!.firstChild!, beta: words[1]!.firstChild! };
}

function select(start: Node, from: number, end: Node, to: number) {
  const range = document.createRange();
  range.setStart(start, from);
  range.setEnd(end, to);
  const selection = document.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
}

describe("read-only source selection in a real shadow root", () => {
  const source = "const alpha = 1;\r\nconst beta = 2;\r\n";

  it("captures the actual source range rather than the retargeted host endpoints", () => {
    const { root, alpha } = sourceRows();
    select(alpha, 0, alpha, 5);
    expect(staticSourceSelection(root, source)).toEqual({ from: 6, to: 11 });
  });

  it("maps a cross-row selection through markup without normalizing CRLF source", () => {
    const { root, alpha, beta } = sourceRows();
    select(alpha, 0, beta, 4);
    const selected = staticSourceSelection(root, source)!;
    expect(selected).toEqual({ from: 6, to: 28 });
    expect(source.slice(selected.from, selected.to)).toBe("alpha = 1;\r\nconst beta");
  });

  it("refuses a caret, another surface's range, and rows that no longer match source", () => {
    const first = sourceRows();
    const second = sourceRows();
    select(first.alpha, 2, first.alpha, 2);
    expect(staticSourceSelection(first.root, source)).toBeNull();
    select(second.alpha, 0, second.alpha, 5);
    expect(staticSourceSelection(first.root, source)).toBeNull();
    select(first.alpha, 0, first.alpha, 5);
    expect(staticSourceSelection(first.root, source.replace("alpha", "gamma"))).toBeNull();
  });
});
