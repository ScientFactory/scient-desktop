import { render as _fixtureRender } from "../../../test/render";
import "../../index.css";

import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vitest/browser";

import { MarkdownSourceSurface } from "~/components/files/FilePreviewPanel";
import { isMacPlatform } from "~/lib/utils";
import type { MarkdownPersistenceLease } from "../markdownEditor/persistence/markdownPersistenceRegistry";
import { MarkdownPersistenceRegistry } from "../markdownEditor/persistence/markdownPersistenceRegistry";
import { createTestCheckpointStore } from "../markdownEditor/persistence/markdownDraftCheckpointTestkit";
import { useLatexSourceCitationOpen, type LatexCitationOpener } from "./useLatexCitationOpener";

const threadRef = {
  environmentId: EnvironmentId.make("latex-citation-open"),
  threadId: ThreadId.make("latex-citation-open"),
};
const SOURCE = "See \\cite{alpha,beta} here.\n";

function createLease() {
  const target = {
    environmentId: threadRef.environmentId,
    cwd: "/latex-citation-open",
    relativePath: "main.tex",
  };
  const registry = new MarkdownPersistenceRegistry({
    checkpointStore: createTestCheckpointStore(),
    debounceMs: 60_000,
    createTransport: () => ({
      write: async () => ({ revision: "saved" }),
      read: async () => ({ source: SOURCE, revision: "initial" }),
      classifyFailure: () => "terminal",
      subscribe: () => () => {},
      project: () => {},
    }),
  });
  const lease = registry.acquire(target, {
    relativePath: target.relativePath,
    contents: SOURCE,
    revision: "initial",
    byteLength: SOURCE.length,
    truncated: false,
  })!;
  return { target, lease };
}

function Source(props: {
  readonly target: ReturnType<typeof createLease>["target"];
  readonly lease: MarkdownPersistenceLease;
  readonly opener: LatexCitationOpener;
}) {
  const handlers = useLatexSourceCitationOpen(
    props.opener,
    () => props.lease.getSnapshot().draftSource,
  );
  return (
    <div
      style={{ display: "flex", width: 800, height: 400 }}
      onPointerDownCapture={handlers.onPointerDown}
      onMouseDownCapture={handlers.onMouseDown}
      onClickCapture={handlers.onClick}
    >
      <MarkdownSourceSurface
        {...props.target}
        threadRef={threadRef}
        composerDraftTarget={threadRef}
        persistence={props.lease}
        resolvedTheme="light"
        wordWrap={false}
        revealRequestId={0}
        onPostRender={() => {}}
      />
    </div>
  );
}

/** Where the rendered text `word` sits inside the first source row, relative to that row. */
function wordInRow(host: HTMLElement, word: string) {
  for (const element of host.querySelectorAll("*")) {
    const row = element.shadowRoot?.querySelector<HTMLElement>('[data-content] > [data-line="1"]');
    if (!row) continue;
    const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const at = node.textContent!.indexOf(word);
      if (at < 0) continue;
      const range = document.createRange();
      range.setStart(node, at + 1);
      range.setEnd(node, at + 2);
      const glyph = range.getBoundingClientRect();
      const bounds = row.getBoundingClientRect();
      return {
        row,
        position: { x: glyph.left - bounds.left + 1, y: glyph.top - bounds.top + glyph.height / 2 },
      };
    }
  }
  return null;
}

it("opens only the clicked key on Command-click (Control-click) and leaves a plain click to the editor", async () => {
  await using stack = new AsyncDisposableStack();
  const host = document.createElement("div");
  document.body.append(host);
  stack.defer(() => host.remove());
  const { target, lease } = createLease();
  stack.defer(() => lease.release());
  const open = vi.fn<LatexCitationOpener["open"]>();
  const opener: LatexCitationOpener = { opens: () => true, open };
  const screen = stack.use(
    await _fixtureRender(<Source target={target} lease={lease} opener={opener} />, {
      container: host,
      router: false,
    }),
  );
  stack.defer(() => screen.unmount());

  // Highlighting replaces the first plain row with tokens; wait for the key's token.
  await vi.waitFor(() =>
    expect(wordInRow(host, "beta")?.row.querySelector("[data-char]")?.textContent ?? "").not.toBe(
      "",
    ),
  );
  const { row, position } = wordInRow(host, "beta")!;
  await userEvent.click(page.elementLocator(row), {
    position,
    modifiers: [isMacPlatform(navigator.platform) ? "Meta" : "Control"],
  });
  expect(open).toHaveBeenCalledOnce();
  expect(open.mock.calls[0]![0]).toEqual([{ key: "beta", locator: null }]);

  // The click moves the selection, which can redraw the row: find it again.
  await vi.waitFor(() => expect(wordInRow(host, "beta")?.row.isConnected).toBe(true));
  const again = wordInRow(host, "beta")!;
  await userEvent.click(page.elementLocator(again.row), { position: again.position });
  expect(open).toHaveBeenCalledOnce();
});
