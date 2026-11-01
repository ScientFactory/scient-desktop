import "../../index.css";

import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { EnvironmentId, ThreadId, type ComputeCitation } from "@t3tools/contracts";
import { useState, type ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { act, render } from "../../../test/render";

import type { ChatComposerHandle } from "~/components/chat/ChatComposer";
import { ComposerHandleContext } from "~/composerHandleContext";
import {
  ComputeQuoteActions,
  computeRunAttributes,
  computeRunPlace,
  useAskAboutCompute,
} from "./ComputeQuoteActions";

const threadRef = {
  environmentId: EnvironmentId.make("environment"),
  threadId: ThreadId.make("thread"),
};
const scope = { threadRef, cwd: "/project" };
const run = { sessionId: "session", executionId: "run", path: "fit.py" };

function createComposer() {
  const citeText = vi.fn(() => true);
  return {
    citeText,
    ref: { current: { citeText } as unknown as ChatComposerHandle },
  };
}

function Feed(props: { readonly children: ReactNode }) {
  const [viewport, setViewport] = useState<HTMLElement | null>(null);
  return (
    <div ref={setViewport} data-assistant-citation-viewport="" style={{ width: 400 }}>
      <ComputeQuoteActions {...scope} viewport={viewport} placeOf={computeRunPlace} />
      {props.children}
    </div>
  );
}

/** A pointer drag as a person makes it, ending in the selection `select` makes. */
async function drag(on: Element, select: () => void) {
  on.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, isPrimary: true }));
  await act(async () => select());
  const { left, top } = on.getBoundingClientRect();
  on.dispatchEvent(
    new MouseEvent("mouseup", { bubbles: true, button: 0, clientX: left + 2, clientY: top + 2 }),
  );
  on.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, button: 0, isPrimary: true }));
}

const action = () => document.querySelector<HTMLButtonElement>('button[aria-label="Ask in chat"]');

function selectText(node: Node) {
  const range = document.createRange();
  range.selectNodeContents(node);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
}

describe("Ask in chat in Compute", () => {
  it("quotes text selected in a run, with the run's place", async () => {
    const composer = createComposer();
    await using _screen = await render(
      <ComposerHandleContext value={composer.ref}>
        <Feed>
          <article {...computeRunAttributes(run)}>
            <pre id="output">mean is 2.0</pre>
          </article>
        </Feed>
      </ComposerHandleContext>,
    );
    const output = document.querySelector("#output")!;
    await drag(output, () => selectText(output));
    await expect.poll(action).not.toBeNull();
    await act(async () => action()!.click());
    const [citation, anchor] = composer.citeText.mock.calls[0] as unknown as [
      ComputeCitation,
      { source: HTMLElement },
    ];
    expect(citation).toMatchObject({
      kind: "compute",
      ...threadRef,
      cwd: "/project",
      place: { _tag: "run", sessionId: "session", executionId: "run", path: "fit.py" },
      text: "mean is 2.0",
    });
    expect(anchor.source.tagName).toBe("ARTICLE");
  });

  it("leaves controls out of a quote that crosses them", async () => {
    const composer = createComposer();
    await using _screen = await render(
      <ComposerHandleContext value={composer.ref}>
        <Feed>
          <article {...computeRunAttributes(run)}>
            <p id="first">before</p>
            <button type="button">Traceback</button>
            <p id="last">after</p>
          </article>
        </Feed>
      </ComposerHandleContext>,
    );
    const article = document.querySelector("article")!;
    await drag(article, () => selectText(article));
    await expect.poll(action).not.toBeNull();
    await act(async () => action()!.click());
    const [citation] = composer.citeText.mock.calls[0] as unknown as [ComputeCitation];
    expect(citation.text).not.toContain("Traceback");
    expect(citation.text).toContain("before");
    expect(citation.text).toContain("after");
  });

  it("offers nothing outside a run", async () => {
    const composer = createComposer();
    await using _screen = await render(
      <ComposerHandleContext value={composer.ref}>
        <Feed>
          <article {...computeRunAttributes(run)}>
            <pre id="output">mean is 2.0</pre>
          </article>
          <p id="notice">Restarted</p>
        </Feed>
      </ComposerHandleContext>,
    );
    const output = document.querySelector("#output")!;
    await drag(output, () => selectText(output));
    await expect.poll(action).not.toBeNull();
    const notice = document.querySelector("#notice")!;
    await drag(notice, () => selectText(notice));
    await expect.poll(action).toBeNull();
  });

  it("offers nothing without a chat to ask in", async () => {
    await using _screen = await render(
      <Feed>
        <article {...computeRunAttributes(run)}>
          <pre id="output">mean is 2.0</pre>
        </article>
      </Feed>,
    );
    const output = document.querySelector("#output")!;
    await drag(output, () => selectText(output));
    expect(action()).toBeNull();
  });

  it("quotes all a code editor selected, not just the lines it has on the page", async () => {
    const composer = createComposer();
    const code = Array.from({ length: 300 }, (_, line) => `value_${line} = ${line}`).join("\n");
    await using _screen = await render(
      <ComposerHandleContext value={composer.ref}>
        <Feed>
          <section {...computeRunAttributes(run)}>
            <div id="editor" style={{ height: 120, overflow: "auto" }} />
          </section>
        </Feed>
      </ComposerHandleContext>,
    );
    const view = new EditorView({
      state: EditorState.create({ doc: code }),
      parent: document.querySelector("#editor")!,
    });
    try {
      // The test page has no window focus, so the page selection is set beside the editor's.
      await drag(view.contentDOM, () => {
        view.dispatch({ selection: { anchor: 0, head: code.length } });
        selectText(view.contentDOM);
      });
      await expect.poll(action).not.toBeNull();
      expect(document.querySelectorAll(".cm-line").length).toBeLessThan(300);
      await act(async () => action()!.click());
      const [citation] = composer.citeText.mock.calls[0] as unknown as [ComputeCitation];
      expect(citation.text).toBe(code);
    } finally {
      view.destroy();
    }
  });
});

it("asks for a shorter selection past what a quote holds, as documents do", async () => {
  const composer = createComposer();
  await using _screen = await render(
    <ComposerHandleContext value={composer.ref}>
      <Feed>
        <article {...computeRunAttributes(run)}>
          <pre id="output">{"x".repeat(8_001)}</pre>
        </article>
      </Feed>
    </ComposerHandleContext>,
  );
  const output = document.querySelector("#output")!;
  await drag(output, () => selectText(output));
  const refused = () => document.querySelector<HTMLButtonElement>("button:disabled");
  await expect.poll(refused).not.toBeNull();
  expect(refused()!.textContent).toBe("Shorten selection");
});

function WholeRun(props: { readonly text: string }) {
  const ask = useAskAboutCompute(scope);
  const [article, setArticle] = useState<HTMLElement | null>(null);
  return (
    <div data-assistant-citation-viewport="">
      <article ref={setArticle}>
        <pre>print(1)</pre>
      </article>
      <button
        type="button"
        onClick={() =>
          article !== null &&
          ask?.({
            source: article,
            place: { _tag: "cell", path: "a.ipynb", cellId: "cell", number: 1 },
            text: props.text,
          })
        }
      >
        Ask
      </button>
    </div>
  );
}

it("remembers which occurrence of a repeated word was selected in an editor", async () => {
  const composer = createComposer();
  const code = "x = 1\nprint(x)";
  await using _screen = await render(
    <ComposerHandleContext value={composer.ref}>
      <Feed>
        <section {...computeRunAttributes(run)}>
          <div id="editor" />
        </section>
      </Feed>
    </ComposerHandleContext>,
  );
  const view = new EditorView({
    state: EditorState.create({ doc: code }),
    parent: document.querySelector("#editor")!,
  });
  try {
    await drag(view.contentDOM, () => {
      view.dispatch({ selection: { anchor: 12, head: 13 } });
      selectText(view.contentDOM);
    });
    await expect.poll(action).not.toBeNull();
    await act(async () => action()!.click());
    const [citation] = composer.citeText.mock.calls[0] as unknown as [ComputeCitation];
    expect(citation).toMatchObject({ text: "x", prefix: "x = 1 print(", suffix: ")" });
  } finally {
    view.destroy();
  }
});

describe("Ask in chat about a whole run or cell", () => {
  it("quotes its code, anchored to it, and never more than a quote holds", async () => {
    const composer = createComposer();
    await using _screen = await render(
      <ComposerHandleContext value={composer.ref}>
        <WholeRun text={` ${"x".repeat(9_000)}\n`} />
      </ComposerHandleContext>,
    );
    await act(async () =>
      document.querySelector<HTMLButtonElement>("button:not([aria-label])")!.click(),
    );
    const [citation, anchor] = composer.citeText.mock.calls[0] as unknown as [
      ComputeCitation,
      { source: HTMLElement; resolveRange: () => Range | null },
    ];
    expect(citation.text).toBe("x".repeat(8_000));
    expect(citation.end).toBe(8_000);
    expect(anchor.source.tagName).toBe("ARTICLE");
    expect(anchor.resolveRange()?.toString()).toBe("print(1)");
  });

  it("has nothing to send a blank cell", async () => {
    const composer = createComposer();
    await using _screen = await render(
      <ComposerHandleContext value={composer.ref}>
        <WholeRun text={"   \n"} />
      </ComposerHandleContext>,
    );
    await act(async () =>
      document.querySelector<HTMLButtonElement>("button:not([aria-label])")!.click(),
    );
    expect(composer.citeText).not.toHaveBeenCalled();
  });
});
