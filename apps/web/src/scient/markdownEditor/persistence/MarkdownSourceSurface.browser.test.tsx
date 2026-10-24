import { render as _fixtureRender } from "../../../../test/render";
import "../../../index.css";

import { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vitest/browser";

import { MarkdownSourceSurface } from "~/components/files/FilePreviewPanel";
import { MarkdownPersistenceRegistry } from "./markdownPersistenceRegistry";
import { createTestCheckpointStore } from "./markdownDraftCheckpointTestkit";
import { editorCompositions } from "../../editorFlush/editorComposition";

it("types at the end after replacing a multiline source and acknowledging its save", async () => {
  await using _fixture = _createFixture();

  const target = {
    environmentId: EnvironmentId.make("source-caret-browser"),
    cwd: "/source-caret-browser",
    relativePath: "source.md",
  };
  let disk = { source: "first\nsecond\nthird\nfourth", revision: "initial" };
  const registry = new MarkdownPersistenceRegistry({
    checkpointStore: createTestCheckpointStore(),
    createTransport: () => ({
      write: async (intent) => {
        expect(intent.expectedRevision).toBe(disk.revision);
        disk = { source: intent.source, revision: disk.revision + "!" };
        return { revision: disk.revision };
      },
      read: async () => disk,
      classifyFailure: () => "terminal",
      subscribe: () => () => {},
      project: () => {},
    }),
  });
  const lease = registry.acquire(target, {
    relativePath: target.relativePath,
    contents: disk.source,
    revision: disk.revision,
    byteLength: disk.source.length,
    truncated: false,
  })!;
  const host = document.createElement("div");
  host.style.cssText = "display:flex;width:800px;height:500px";
  document.body.append(host);
  const root = _fixture.stack.use(await _fixtureRender(null, { container: host, router: false }));
  try {
    await root.rerender(
      <MarkdownSourceSurface
        persistence={lease}
        {...target}
        composerDraftTarget={{
          environmentId: target.environmentId,
          threadId: ThreadId.make("source-caret"),
        }}
        resolvedTheme="light"
        revealRequestId={0}
        wordWrap={false}
        onPostRender={() => {}}
      />,
    );
    const source = page.getByRole("textbox");
    await userEvent.click(source);
    await userEvent.keyboard("{ControlOrMeta>}a{/ControlOrMeta}");
    await userEvent.keyboard("x{Enter}y{Enter}z{Enter}w");
    await expect.poll(() => lease.getSnapshot().draftSource).toBe("x\ny\nz\nw");
    expect(await lease.flushNow()).toBe(true);
    await expect.poll(() => lease.getSnapshot().pending).toBe(false);
    await vi.waitFor(() => {
      const selection = document.getSelection()!;
      expect(selection.isCollapsed).toBe(true);
      expect(selection.anchorNode?.textContent).toBe("w");
      expect(selection.anchorOffset).toBe(1);
    });
    await userEvent.keyboard("!");
    await expect.poll(() => lease.getSnapshot().draftSource).toBe("x\ny\nz\nw!");
    expect(await lease.flushNow()).toBe(true);
    expect(disk.source).toBe("x\ny\nz\nw!");
  } finally {
    await root.unmount();
    host.remove();
    lease.release();
  }
});

it("tells a folder flush while an input method composes in the source editor", async () => {
  await using _fixture = _createFixture();

  const target = {
    environmentId: EnvironmentId.make("source-composition-browser"),
    cwd: "/source-composition-browser",
    relativePath: "paper/source.md",
  };
  const registry = new MarkdownPersistenceRegistry({
    checkpointStore: createTestCheckpointStore(),
    createTransport: () => ({
      write: async () => ({ revision: "next" }),
      read: async () => ({ source: "text", revision: "initial" }),
      classifyFailure: () => "terminal",
      subscribe: () => () => {},
      project: () => {},
    }),
  });
  const lease = registry.acquire(target, {
    relativePath: target.relativePath,
    contents: "text",
    revision: "initial",
    byteLength: 4,
    truncated: false,
  })!;
  const host = document.createElement("div");
  host.style.cssText = "display:flex;width:800px;height:500px";
  document.body.append(host);
  const root = _fixture.stack.use(await _fixtureRender(null, { container: host, router: false }));
  const composing = () =>
    editorCompositions.composingWhere((file) => file.environmentId === target.environmentId);
  try {
    await root.rerender(
      <MarkdownSourceSurface
        persistence={lease}
        {...target}
        composerDraftTarget={{
          environmentId: target.environmentId,
          threadId: ThreadId.make("source-composition"),
        }}
        resolvedTheme="light"
        revealRequestId={0}
        wordWrap={false}
        onPostRender={() => {}}
      />,
    );
    const source = page.getByRole("textbox");
    await userEvent.click(source);
    expect(composing()).toEqual([]);
    source.element().dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    await expect.poll(composing).toEqual([target]);
    source.element().dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    await expect.poll(composing).toEqual([]);
  } finally {
    await root.unmount();
    host.remove();
    lease.release();
  }
  expect(editorCompositions.targets()).not.toContainEqual(target);
});

function _createFixture() {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
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
