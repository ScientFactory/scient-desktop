import "../../../index.css";

import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { createRoot } from "react-dom/client";
import { expect, it } from "vite-plus/test";
import { page, userEvent } from "vitest/browser";

import { MarkdownSourceSurface } from "~/components/files/FilePreviewPanel";
import { MarkdownPersistenceRegistry } from "./markdownPersistenceRegistry";

it("types at the end after replacing a multiline source and acknowledging its save", async () => {
  const target = {
    environmentId: EnvironmentId.make("source-caret-browser"),
    cwd: "/source-caret-browser",
    relativePath: "source.md",
  };
  let disk = { source: "first\nsecond\nthird\nfourth", revision: "initial" };
  const registry = new MarkdownPersistenceRegistry({
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
  const root = createRoot(host);
  try {
    root.render(
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
    root.unmount();
    host.remove();
    lease.release();
  }
});
