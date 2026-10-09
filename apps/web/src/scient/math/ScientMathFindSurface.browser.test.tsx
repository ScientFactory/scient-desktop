import "../../index.css";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it } from "vite-plus/test";
import { MarkdownFindContext } from "~/components/chat/markdownFindContext";
import {
  collectThreadFindRanges,
  useThreadFindHighlights,
} from "~/components/chat/threadFindHighlights";
import { chatMarkdownClipboardPayload } from "~/markdown-clipboard";
import { ScientMathFindSurface } from "./ScientMathFindSurface";
import { renderCachedScientMath, ScientInlineMath } from "./ScientMath";
import * as katexRuntime from "./katexRuntime";

let root: Root | undefined;
let host: HTMLDivElement | undefined;
afterEach(() => {
  window.getSelection()?.removeAllRanges();
  root?.unmount();
  host?.remove();
  root = undefined;
  host = undefined;
});

const nextFrame = () =>
  new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 16)));
const tex = "x_{browser_find}^2";

it("reveals a selected formula source in Chromium while preserving KaTeX and one-copy semantics", async () => {
  renderCachedScientMath(katexRuntime, tex, false);
  host = document.createElement("div");
  host.style.width = "640px";
  document.body.append(host);
  root = createRoot(host);
  const container = host;
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
  root.render(<Probe query="" />);
  await nextFrame();
  await nextFrame();
  const formula = host.querySelector(".katex");
  expect(formula).not.toBeNull();
  const source = host.querySelector<HTMLElement>("[data-thread-find-canonical-source]")!;
  expect(source.hidden).toBe(true);

  root.render(<Probe query="browser_find" />);
  await expect.poll(() => source.hidden).toBe(false);
  await nextFrame();
  expect(source.getBoundingClientRect().height).toBeGreaterThan(0);
  expect(host.querySelector(".katex")).toBe(formula);
  expect(collectThreadFindRanges(host, "browser_find")).toHaveLength(1);
  expect(source.getAttribute("aria-hidden")).toBe("true");

  const selection = window.getSelection()!;
  const range = document.createRange();
  range.selectNode(host.querySelector("p")!);
  selection.removeAllRanges();
  selection.addRange(range);
  const payload = chatMarkdownClipboardPayload(selection)!;
  expect(payload.text.match(/browser_find/g)).toHaveLength(1);
  const copiedHtml = document.createElement("div");
  copiedHtml.innerHTML = payload.html;
  expect(copiedHtml.textContent?.match(/browser_find/g)).toHaveLength(1);
  expect(copiedHtml.querySelector("[data-thread-find-canonical-source], .katex, math")).toBeNull();

  root.render(<Probe query="" searching={false} />);
  await expect.poll(() => host?.querySelector("[data-thread-find-canonical-source]")).toBeNull();
  expect(host.querySelector(".katex")).toBe(formula);
});
