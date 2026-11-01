import { render as _fixtureRender } from "../../../test/render";
import "../../index.css";

import type { DocumentSaveIntent } from "@scientfactory/scient-document";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vitest/browser";
import { MarkdownSourceSurface } from "~/components/files/FilePreviewPanel";
import type { MarkdownCiteHandler } from "../markdownEditor/markdownCitation";
import { MarkdownPersistenceRegistry } from "../markdownEditor/persistence/markdownPersistenceRegistry";
import { createTestCheckpointStore } from "../markdownEditor/persistence/markdownDraftCheckpointTestkit";
import type { SourceCaretQuote } from "./SourceCitationActions";
import { StaticTextFileSurface } from "./StaticTextFileSurface";

const threadRef = {
  environmentId: EnvironmentId.make("source-citation-browser"),
  threadId: ThreadId.make("source-citation-browser"),
};

async function mount(_fixture: _Fixture) {
  const host = document.createElement("div");
  host.style.cssText = "display:flex;width:800px;height:500px";
  document.body.append(host);
  return {
    host,
    root: _fixture.stack.use(await _fixtureRender(null, { container: host, router: false })),
  };
}

function sourceRow(host: HTMLElement, line: number): HTMLElement | null {
  for (const element of host.querySelectorAll("*")) {
    const row = element.shadowRoot?.querySelector<HTMLElement>(
      `[data-content] > [data-line="${line}"]`,
    );
    if (row) return row;
  }
  return null;
}

it("activates a read-only shadow-DOM quote after focus moves and the native range collapses", async () => {
  await using _fixture = _createFixture();

  const { host, root } = await mount(_fixture);
  const onCite = vi.fn<MarkdownCiteHandler>(() => true);
  try {
    await root.rerender(
      <StaticTextFileSurface
        threadRef={threadRef}
        onCite={onCite}
        contents={"const alpha = 1;\r\nconst beta = 2;\r\n"}
        cwd="/source-citation-browser"
        relativePath="read-only.ts"
        resolvedTheme="light"
        wordWrap={false}
        onPostRender={() => {}}
      />,
    );
    // The initial plain-text row is replaced when highlighting finishes.
    // Start the selection gesture on its rendered token, as a user would.
    await userEvent.click(page.getByText("alpha", { exact: true }));
    const row = sourceRow(host, 1)!;
    const range = document.createRange();
    const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
    let offset = 0;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const end = offset + node.textContent!.length;
      if (offset <= 6 && 6 < end) range.setStart(node, 6 - offset);
      if (offset < 11 && 11 <= end) {
        range.setEnd(node, 11 - offset);
        break;
      }
      offset = end;
    }
    expect(range.toString()).toBe("alpha");
    document.getSelection()!.removeAllRanges();
    document.getSelection()!.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
    const action = page.getByRole("button", { name: "Ask in chat", exact: true });
    await expect.element(action).toBeVisible();
    (action.element() as HTMLButtonElement).focus();
    document.getSelection()!.removeAllRanges();
    // Activation uses the captured source, even when focusing the action has
    // already collapsed the native range.
    (action.element() as HTMLButtonElement).click();
    expect(onCite).toHaveBeenCalledOnce();
    expect(onCite.mock.calls[0]![0]).toMatchObject({
      path: "read-only.ts",
      text: "alpha",
      sourceStart: 6,
      sourceEnd: 11,
      startLine: 1,
      endLine: 1,
      sourceSelection: true,
      origin: "saved",
    });
  } finally {
    await root.unmount();
    document.getSelection()?.removeAllRanges();
    host.remove();
  }
});

function createLease(source: string) {
  const target = {
    environmentId: threadRef.environmentId,
    cwd: "/source-citation-browser",
    relativePath: "cells.py",
  };
  const registry = new MarkdownPersistenceRegistry({
    checkpointStore: createTestCheckpointStore(),
    debounceMs: 60_000,
    createTransport: () => ({
      write: async () => ({ revision: "saved" }),
      read: async () => ({ source, revision: "initial" }),
      classifyFailure: () => "terminal",
      subscribe: () => () => {},
      project: () => {},
    }),
  });
  const lease = registry.acquire(target, {
    relativePath: target.relativePath,
    contents: source,
    revision: "initial",
    byteLength: source.length,
    truncated: false,
  })!;
  return { target, lease };
}

const CELLS = "# %% one\nvalue = 1\nprint(value)\n\n# %% two\nother = 2\n";
const secondCell: SourceCaretQuote = (source) => ({
  from: source.indexOf("value = 1"),
  to: source.indexOf("\n\n# %% two"),
});

function selectionCollapsed(host: HTMLElement) {
  const shadowRoots = [...host.querySelectorAll("*")].flatMap((element) =>
    element.shadowRoot ? [element.shadowRoot] : [],
  );
  return document.getSelection()!.getComposedRanges({ shadowRoots })[0]?.collapsed;
}

it("offers the block around a clicked caret and quotes it", async () => {
  await using _fixture = _createFixture();

  const { root } = await mount(_fixture);
  const { target, lease } = createLease(CELLS);
  const onCite = vi.fn<MarkdownCiteHandler>(() => true);
  await root.rerender(
    <MarkdownSourceSurface
      {...target}
      threadRef={threadRef}
      composerDraftTarget={threadRef}
      persistence={lease}
      onCite={onCite}
      caretQuote={secondCell}
      resolvedTheme="light"
      wordWrap={false}
      revealRequestId={0}
      onPostRender={() => {}}
    />,
  );
  await userEvent.click(page.getByText("value", { exact: true }).first());
  await userEvent.click(page.getByRole("button", { name: "Ask in chat", exact: true }));
  expect(onCite).toHaveBeenCalledOnce();
  expect(onCite.mock.calls[0]![0]).toMatchObject({
    text: "value = 1\nprint(value)",
    startLine: 2,
    endLine: 3,
  });
});

it("keeps a selection when the active range changes, since the editor is not rebuilt", async () => {
  await using _fixture = _createFixture();

  const { host, root } = await mount(_fixture);
  const { target, lease } = createLease(CELLS);
  // A callback that changes identity rebuilds the editor by itself.
  const onPostRender = () => {};
  const surface = (activeLineRange: { start: number; end: number } | null) => (
    <MarkdownSourceSurface
      {...target}
      threadRef={threadRef}
      composerDraftTarget={threadRef}
      persistence={lease}
      activeLineRange={activeLineRange}
      resolvedTheme="light"
      wordWrap={false}
      revealRequestId={0}
      onPostRender={onPostRender}
    />
  );
  await root.rerender(surface({ start: 2, end: 3 }));
  await userEvent.click(page.getByRole("textbox"));
  await userEvent.keyboard("{ControlOrMeta>}a{/ControlOrMeta}");
  await expect.poll(() => selectionCollapsed(host)).toBe(false);
  await root.rerender(surface(null));
  await expect.poll(() => sourceRow(host, 2)?.hasAttribute("data-selected-line")).toBe(false);
  expect(selectionCollapsed(host)).toBe(false);
});

it("runs on Cmd+Enter without the editor also inserting a line", async () => {
  await using _fixture = _createFixture();

  const { root } = await mount(_fixture);
  const { target, lease } = createLease(CELLS);
  const onRunShortcut = vi.fn();
  await root.rerender(
    <MarkdownSourceSurface
      {...target}
      threadRef={threadRef}
      composerDraftTarget={threadRef}
      persistence={lease}
      onRunShortcut={onRunShortcut}
      resolvedTheme="light"
      wordWrap={false}
      revealRequestId={0}
      onPostRender={() => {}}
    />,
  );
  await userEvent.click(page.getByRole("textbox"));
  await userEvent.keyboard("{ControlOrMeta>}{Enter}{/ControlOrMeta}");
  expect(onRunShortcut).toHaveBeenCalledOnce();
  expect(lease.getSnapshot().draftSource).toBe(CELLS);
});

it("quotes the editable model's exact draft and CRLF range through the real toolbar", async () => {
  await using _fixture = _createFixture();

  const { host, root } = await mount(_fixture);
  const target = {
    environmentId: threadRef.environmentId,
    cwd: "/source-citation-browser",
    relativePath: "editable.ts",
  };
  const source = "const alpha = 1;\r\nconst beta = 2;\r\n";
  let disk = { source, revision: "initial" };
  const writes: DocumentSaveIntent[] = [];
  let acknowledgeWrite!: (receipt: { revision: string }) => void;
  const acknowledgement = new Promise<{ revision: string }>((resolve) => {
    acknowledgeWrite = resolve;
  });
  const registry = new MarkdownPersistenceRegistry({
    checkpointStore: createTestCheckpointStore(),
    debounceMs: 60_000,
    createTransport: () => ({
      write: async (intent) => {
        writes.push(intent);
        const receipt = await acknowledgement;
        disk = { source: intent.source, revision: receipt.revision };
        return receipt;
      },
      read: async () => disk,
      classifyFailure: () => "terminal",
      subscribe: () => () => {},
      project: () => {},
    }),
  });
  const lease = registry.acquire(target, {
    relativePath: target.relativePath,
    contents: source,
    revision: "initial",
    byteLength: source.length,
    truncated: false,
  })!;
  const draft = "// unsaved\r\n" + source;
  expect(lease.change(draft, lease.getSnapshot().editVersion)).toBe(true);
  // Autosave's maximum wait also applies with a long debounce. Keep the real
  // owned write unacknowledged while exercising the draft citation contract.
  const pendingSave = lease.flushNow();
  const onCite = vi.fn<MarkdownCiteHandler>(() => true);
  try {
    await expect
      .poll(() => writes)
      .toEqual([
        {
          source: draft,
          expectedRevision: "initial",
          editVersion: 1,
          mutationId: expect.any(String),
        },
      ]);
    expect(lease.getSnapshot()).toMatchObject({
      baselineSource: source,
      draftSource: draft,
      pending: true,
      inFlight: true,
    });
    await root.rerender(
      <MarkdownSourceSurface
        {...target}
        threadRef={threadRef}
        composerDraftTarget={threadRef}
        persistence={lease}
        onCite={onCite}
        resolvedTheme="light"
        wordWrap={false}
        revealRequestId={0}
        onPostRender={() => {}}
      />,
    );
    const textbox = page.getByRole("textbox");
    await userEvent.click(textbox);
    const nativeEditor = textbox.element();
    await userEvent.keyboard("{ControlOrMeta>}a{/ControlOrMeta}");
    await userEvent.click(page.getByRole("button", { name: "Ask in chat", exact: true }));
    expect(onCite).toHaveBeenCalledOnce();
    expect(onCite.mock.calls[0]![0]).toMatchObject({
      text: draft,
      sourceStart: 0,
      sourceEnd: draft.length,
      startLine: 1,
      endLine: 3,
      sourceSelection: true,
      origin: "draft",
    });
    expect(lease.getSnapshot().draftSource).toBe(draft);
    expect(lease.getSnapshot().baselineSource).toBe(source);

    acknowledgeWrite({ revision: "saved" });
    expect(await pendingSave).toBe(true);
    expect(disk).toEqual({ source: draft, revision: "saved" });
    expect(lease.getSnapshot()).toMatchObject({
      baselineSource: draft,
      baselineRevision: "saved",
      draftSource: draft,
      pending: false,
      inFlight: false,
    });
    await userEvent.click(textbox);
    expect(textbox.element()).toBe(nativeEditor);
    await userEvent.keyboard("{ControlOrMeta>}a{/ControlOrMeta}");
    await userEvent.click(page.getByRole("button", { name: "Ask in chat", exact: true }));
    expect(onCite).toHaveBeenCalledTimes(2);
    expect(onCite.mock.calls[1]![0]).toMatchObject({
      text: draft,
      sourceStart: 0,
      sourceEnd: draft.length,
      startLine: 1,
      endLine: 3,
      sourceSelection: true,
      origin: "saved",
    });
  } finally {
    acknowledgeWrite({ revision: "saved" });
    await pendingSave;
    await root.unmount();
    document.getSelection()?.removeAllRanges();
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
