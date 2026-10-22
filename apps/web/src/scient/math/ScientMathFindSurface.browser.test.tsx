import { render as _fixtureRender, type Screen } from "../../../test/render";
import "../../index.css";

import { expect, it, vi } from "vite-plus/test";
import { MarkdownFindContext } from "~/components/chat/markdownFindContext";
import {
  collectThreadFindRanges,
  useThreadFindHighlights,
} from "~/components/chat/threadFindHighlights";
import { chatMarkdownClipboardPayload } from "~/markdown-clipboard";
import { ScientMathFindSurface } from "./ScientMathFindSurface";
import { renderCachedScientMath, ScientInlineMath } from "./ScientMath";
import * as katexRuntime from "./katexRuntime";

async function _cleanupFixture0(_fixture: _Fixture) {
  window.getSelection()?.removeAllRanges();
  await _fixture.root0?.unmount();
  _fixture.host?.remove();
  _fixture.root0 = undefined;
  _fixture.host = undefined;
}

const tex = "x_{browser_find}^2";

it("reveals a selected formula source in Chromium while preserving KaTeX and one-copy semantics", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  renderCachedScientMath(katexRuntime, tex, false);
  _fixture.host = document.createElement("div");
  _fixture.host.style.width = "640px";
  document.body.append(_fixture.host);
  _fixture.root0 = _fixture.stack.use(
    await _fixtureRender(null, { container: _fixture.host, router: false }),
  );
  const container = _fixture.host;
  function Probe({ query, searching = true }: { query: string; searching?: boolean }) {
    useThreadFindHighlights({
      container,
      query,
      activeRowId: "math",
      activeOccurrence: 0,
      onActiveRange: () => {},
    });
    return (
      <div data-timeline-row-id="math">
        <p data-thread-find-text>
          <MarkdownFindContext value={searching}>
            <ScientMathFindSurface sourceText={`$$${tex}$$`}>
              <ScientInlineMath tex={tex} />
            </ScientMathFindSurface>
          </MarkdownFindContext>
        </p>
      </div>
    );
  }
  await _fixture.root0.rerender(<Probe query="" />);
  await vi.waitFor(() => expect(_fixture.host!.querySelector(".katex")).not.toBeNull());
  await vi.waitFor(() =>
    expect(_fixture.host!.querySelector(".katex")!.getBoundingClientRect().height).toBeGreaterThan(
      0,
    ),
  );
  const formula = _fixture.host.querySelector(".katex");
  expect(formula).not.toBeNull();
  const source = _fixture.host.querySelector<HTMLElement>("[data-thread-find-canonical-source]")!;
  expect(source.hidden).toBe(true);

  await _fixture.root0.rerender(<Probe query="browser_find" />);
  await expect.poll(() => source.hidden).toBe(false);
  await vi.waitFor(() => expect(source.getBoundingClientRect().height).toBeGreaterThan(0));
  expect(_fixture.host.querySelector(".katex")).toBe(formula);
  expect(collectThreadFindRanges(_fixture.host, "browser_find")).toHaveLength(1);
  expect(source.getAttribute("aria-hidden")).toBe("true");

  const selection = window.getSelection()!;
  const range = document.createRange();
  range.selectNode(_fixture.host.querySelector("p")!);
  selection.removeAllRanges();
  selection.addRange(range);
  const payload = chatMarkdownClipboardPayload(selection)!;
  expect(payload.text.match(/browser_find/g)).toHaveLength(1);
  const copiedHtml = document.createElement("div");
  copiedHtml.innerHTML = payload.html;
  expect(copiedHtml.textContent?.match(/browser_find/g)).toHaveLength(1);
  expect(copiedHtml.querySelector("[data-thread-find-canonical-source], .katex, math")).toBeNull();

  await _fixture.root0.rerender(<Probe query="" searching={false} />);
  await expect
    .poll(() => _fixture.host?.querySelector("[data-thread-find-canonical-source]"))
    .toBeNull();
  expect(_fixture.host.querySelector(".katex")).toBe(formula);
});

function _createFixture() {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    host: undefined! as HTMLDivElement | undefined,
    stack,
    cleanup,
    root0: undefined! as Screen | undefined,
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
