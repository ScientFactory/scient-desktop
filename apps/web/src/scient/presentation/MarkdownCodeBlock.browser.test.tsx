import { render, act } from "../../../test/render";

import { expect, it, vi } from "vite-plus/test";

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

import { MarkdownCodeBlock } from "./MarkdownCodeBlock";

function setupHighlighterReadiness() {
  const ready = Promise.withResolvers<void>();
  highlighterBarrier.ready = ready.promise;
  highlighterBarrier.promises.clear();
  highlighterBarrier.requested.mockClear();
  return {
    release: () => ready.resolve(),
    [Symbol.dispose]() {
      ready.resolve();
      highlighterBarrier.ready = null;
      highlighterBarrier.promises.clear();
      highlighterBarrier.requested.mockClear();
    },
  };
}

it("holds a loading block's code unseen but readable, for screen readers and Copy message", async () => {
  using readiness = setupHighlighterReadiness();
  // Unmount before releasing/restoring the low-level promise seam, also on failure.
  await using root = await render(null, { router: false });
  const host = root.container;
  const code = "const a = 1;\n";
  await act(
    async () =>
      await root.rerender(
        <MarkdownCodeBlock code={code} language="ts" fenceTitle={null} theme="light" />,
      ),
  );
  expect(highlighterBarrier.requested).toHaveBeenCalledWith("ts");
  const placeholder = host.querySelector(".invisible");
  expect(placeholder?.textContent).toBe(code);
  expect(placeholder?.closest("[aria-hidden]")).toBeNull();
  expect(host.querySelector(".chat-markdown-shiki")).toBeNull();
  await act(() => readiness.release());
  await expect.poll(() => host.querySelector(".invisible")).toBeNull();
  const highlighted = host.querySelector(".chat-markdown-shiki")!;
  expect(highlighted.querySelector("code")?.textContent?.trimEnd()).toBe(code.trimEnd());
  expect(highlighted.querySelector('code span[style*="color"]')).not.toBeNull();
  expect(highlighted.closest("[aria-hidden]")).toBeNull();
});
