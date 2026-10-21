import { render as _fixtureRender } from "../../../../test/render";
import "../../../index.css";

import { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { expect, it } from "vite-plus/test";
import { page, userEvent } from "vitest/browser";

import { MarkdownSourceSurface } from "~/components/files/FilePreviewPanel";
import { MarkdownPersistenceRegistry } from "./markdownPersistenceRegistry";
import { createTestCheckpointStore } from "./markdownDraftCheckpointTestkit";

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
    // Let native selectionchange and highlighting settle before the next key.
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
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
