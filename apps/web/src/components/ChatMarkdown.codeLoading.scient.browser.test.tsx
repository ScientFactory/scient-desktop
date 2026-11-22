import { expect, it, vi } from "vite-plus/test";

import { act, render } from "../../test/render";
import "../index.css";

const highlighterBarrier = vi.hoisted(() => ({
  ready: null as Promise<void> | null,
  promises: new Map<
    string,
    ReturnType<typeof import("~/lib/syntaxHighlighting").getSyntaxHighlighterPromise>
  >(),
  requested: vi.fn(),
}));

vi.mock("~/lib/syntaxHighlighting", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/lib/syntaxHighlighting")>();
  return {
    ...actual,
    getSyntaxHighlighterPromise(language: string) {
      const ready = highlighterBarrier.ready;
      if (!ready) return actual.getSyntaxHighlighterPromise(language);
      highlighterBarrier.requested(language);
      let promise = highlighterBarrier.promises.get(language);
      if (!promise) {
        // Retain the real highlighter (including a warm singleton), but withhold its result.
        promise = actual.getSyntaxHighlighterPromise(language).then(
          (highlighter) => ready.then(() => highlighter),
          (cause: unknown) =>
            ready.then(() => {
              throw cause;
            }),
        );
        highlighterBarrier.promises.set(language, promise);
      }
      return promise;
    },
  };
});

import ChatMarkdown from "./ChatMarkdown";

function holdHighlighter() {
  const ready = Promise.withResolvers<void>();
  highlighterBarrier.ready = ready.promise;
  highlighterBarrier.promises.clear();
  highlighterBarrier.requested.mockClear();
  return {
    async release() {
      ready.resolve();
      // Opening the gate is not completion of a cold WASM/grammar load.
      await Promise.all(highlighterBarrier.promises.values());
    },
    [Symbol.dispose]() {
      ready.resolve();
      highlighterBarrier.ready = null;
      highlighterBarrier.promises.clear();
    },
  };
}

// Copy message drops aria-hidden content, so the placeholder must stay in the accessible tree.
it("holds a loading code block's text unseen but readable, for screen readers and Copy message", async () => {
  using highlighter = holdHighlighter();
  await using screen = await render(
    <ChatMarkdown cwd="/tmp/project" text={"```ts\nconst a = 1;\n```"} />,
  );
  const block = () => screen.container.querySelector(".chat-markdown-codeblock");
  await vi.waitFor(() => expect(highlighterBarrier.requested).toHaveBeenCalledWith("ts"));
  const placeholder = block()?.querySelector(".invisible");
  expect(placeholder?.textContent).toContain("const a = 1;");
  expect(placeholder?.closest("[aria-hidden]")).toBeNull();
  expect(block()?.querySelector(".chat-markdown-shiki")).toBeNull();

  await act(() => highlighter.release());
  await vi.waitFor(() => expect(block()?.querySelector(".chat-markdown-shiki")).not.toBeNull());
  expect(block()?.querySelector(".invisible")).toBeNull();
});
