import katex from "katex";
import { describe, expect, it } from "vite-plus/test";
import { chatMarkdownClipboardPayload } from "./markdown-clipboard";

async function _cleanupFixture0(_fixture: _Fixture) {
  await _clearOwnedDOM(_fixture);
}

function fixture(_fixture: _Fixture, display = false) {
  const host = document.createElement("p");
  const math = document.createElement("span");
  math.className = display ? "scient-math-display" : "scient-math-inline";
  math.dataset.markdownCopy = display ? "$$\npH\n$$\n\n" : "$$pH$$";
  math.innerHTML = katex.renderToString("pH", { displayMode: display });
  host.append("Before ", math, " after");
  document.body.append(_ownDOM(_fixture, host));
  return { host, math };
}

function copy(range: Range) {
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  const payload = chatMarkdownClipboardPayload(selection)!;
  const html = document.createElement("div");
  html.innerHTML = payload.html;
  return { payload, html };
}

describe("rendered math clipboard export", () => {
  it.each([false, true])(
    "exports each formula once in both formats (display=%s)",
    async (display) => {
      await using _fixture = _createFixture();
      _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

      const { host, math } = fixture(_fixture, display);
      const original = host.innerHTML;
      const range = document.createRange();
      range.selectNode(host);
      const { payload, html } = copy(range);
      expect(payload.text.match(/pH/g)).toHaveLength(1);
      expect(html.textContent?.match(/pH/g)).toHaveLength(1);
      expect(html.textContent).toContain(math.dataset.markdownCopy);
      expect(html.querySelector("math, annotation, .katex")).toBeNull();
      expect(host.innerHTML).toBe(original);
      expect(math.querySelector("math")).not.toBeNull();
    },
  );

  it("copies a partial visual formula as one complete source without mutating the selection", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    const { math } = fixture(_fixture);
    const text = math.querySelector(".katex-html .mord")!.firstChild!;
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 1);
    const { payload, html } = copy(range);
    expect(payload.text).toBe("$$pH$$");
    expect(html.textContent).toBe("$$pH$$");
    expect(range.startContainer).toBe(text);
    expect(range.endOffset).toBe(1);
  });

  it("preserves surrounding prose when a selection ends within math", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    const { host, math } = fixture(_fixture);
    const range = document.createRange();
    range.setStart(host.firstChild!, 0);
    range.setEnd(math.querySelector(".katex-html .mord")!.firstChild!, 1);
    const { payload, html } = copy(range);
    expect(payload.text).toBe("Before $$pH$$");
    expect(html.textContent).toBe("Before $$pH$$");
  });

  it("preserves following prose when a selection starts within math", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    const { host, math } = fixture(_fixture);
    const range = document.createRange();
    range.setStart(math.querySelector(".katex-html .mord")!.firstChild!, 0);
    range.setEnd(host.lastChild!, 6);
    const { payload, html } = copy(range);
    expect(payload.text).toBe("$$pH$$ after");
    expect(html.textContent).toBe("$$pH$$ after");
  });

  it("exports source containing HTML characters as literal text", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    const { host, math } = fixture(_fixture);
    const source = "$$x < y & \\text{<img src=x onerror=alert(1)>}$$";
    math.dataset.markdownCopy = source;
    const range = document.createRange();
    range.selectNode(host);
    const { payload, html } = copy(range);
    expect(payload.text).toContain(source);
    expect(html.textContent).toContain(source);
    expect(html.querySelector("img")).toBeNull();
  });
});

function _createFixture() {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    _ownedDOM: [] as Node[],

    stack,
    cleanup,
    async [Symbol.asyncDispose]() {
      try {
        await cleanup.disposeAsync();
      } finally {
        await stack.disposeAsync();
      }
    },
  };
}
type _Fixture = ReturnType<typeof _createFixture>;

function _ownDOM<T extends Node>(_fixture: _Fixture, node: T): T {
  _fixture._ownedDOM.push(node);
  _fixture.stack.defer(() => {
    node.parentNode?.removeChild(node);
  });
  return node;
}
function _clearOwnedDOM(_fixture: _Fixture) {
  for (const node of _fixture._ownedDOM.splice(0)) node.parentNode?.removeChild(node);
}
