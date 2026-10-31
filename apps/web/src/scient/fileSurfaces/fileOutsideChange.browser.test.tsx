import { render } from "../../../test/render";
import "../../index.css";

import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useState } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vitest/browser";

import { DiffWorkerPoolProvider } from "~/components/DiffWorkerPoolProvider";
import { EditableFileEditor } from "~/components/files/FilePreviewPanel";

const threadRef = {
  environmentId: EnvironmentId.make("outside-change"),
  threadId: ThreadId.make("outside-change"),
};

function rows() {
  for (const element of document.querySelectorAll("*")) {
    const list = element.shadowRoot?.querySelectorAll("[data-content] > [data-line]");
    if (list?.length) return [...list].map((row) => row.textContent?.replace(/\n$/, ""));
  }
  return [];
}

/** Your typing comes back as the file's latest text, as the app's file query does. */
function Editor(props: {
  readonly relativePath: string;
  readonly contents: string;
  readonly onContentsChange: (source: string) => void;
  readonly editingBlocked?: boolean;
}) {
  const [contents, setContents] = useState(props.contents);
  const [outside, setOutside] = useState(props.contents);
  if (outside !== props.contents) {
    setOutside(props.contents);
    setContents(props.contents);
  }
  return (
    <DiffWorkerPoolProvider>
      <div style={{ display: "flex", width: 800, height: 400 }}>
        <EditableFileEditor
          environmentId={threadRef.environmentId}
          cwd="/outside-change"
          composerDraftTarget={threadRef}
          threadRef={threadRef}
          revision="revision"
          resolvedTheme="light"
          wordWrap={false}
          revealRequestId={0}
          onPostRender={onPostRender}
          relativePath={props.relativePath}
          editingBlocked={props.editingBlocked ?? false}
          contents={contents}
          onContentsChange={(source) => {
            setContents(source);
            props.onContentsChange(source);
          }}
        />
      </div>
    </DiffWorkerPoolProvider>
  );
}

const onPostRender = () => {};
const ORIGINAL = "one = 1\ntwo = 2\nthree = 3\n";
const textbox = () => page.getByRole("textbox").last();

describe.each(["script.py", "notes.txt", "data.json"])("an open %s", (name) => {
  /** Paths stay apart because an editor's retained state outlives each test's mount. */
  const fileName = (test: string) => `${test}-${name}`;

  it("shows an outside change and does not save it back", async () => {
    const onContentsChange = vi.fn();
    const relativePath = fileName("shows");
    await using screen = await render(
      <Editor
        relativePath={relativePath}
        contents={ORIGINAL}
        onContentsChange={onContentsChange}
      />,
      { router: false },
    );
    await expect.poll(rows).toEqual(["one = 1", "two = 2", "three = 3", ""]);
    await screen.rerender(
      <Editor
        relativePath={relativePath}
        contents={"changed = 1\ntwo = 2\nthree = 3\n"}
        onContentsChange={onContentsChange}
      />,
    );
    await expect.poll(rows).toEqual(["changed = 1", "two = 2", "three = 3", ""]);
    expect(onContentsChange).not.toHaveBeenCalled();
  });

  it("keeps your place and focus through an outside change elsewhere", async () => {
    const onContentsChange = vi.fn();
    const relativePath = fileName("place");
    await using screen = await render(
      <Editor
        relativePath={relativePath}
        contents={ORIGINAL}
        onContentsChange={onContentsChange}
      />,
      { router: false },
    );
    await expect.poll(rows).toEqual(["one = 1", "two = 2", "three = 3", ""]);
    await userEvent.click(textbox());
    await userEvent.keyboard("{ControlOrMeta>}{ArrowUp}{/ControlOrMeta}{ArrowDown}{ArrowDown}");
    await screen.rerender(
      <Editor
        relativePath={relativePath}
        contents={"added = 0\none = 1\ntwo = 2\nthree = 3\n"}
        onContentsChange={onContentsChange}
      />,
    );
    await expect.poll(rows).toEqual(["added = 0", "one = 1", "two = 2", "three = 3", ""]);
    await userEvent.keyboard("x");
    await expect.poll(rows).toEqual(["added = 0", "one = 1", "two = 2", "xthree = 3", ""]);
  });

  it("takes back your own edit, not the outside change", async () => {
    const onContentsChange = vi.fn();
    const relativePath = fileName("undo");
    await using screen = await render(
      <Editor
        relativePath={relativePath}
        contents={ORIGINAL}
        onContentsChange={onContentsChange}
      />,
      { router: false },
    );
    await expect.poll(rows).toEqual(["one = 1", "two = 2", "three = 3", ""]);
    await userEvent.click(textbox());
    await userEvent.keyboard("{ControlOrMeta>}{ArrowUp}{/ControlOrMeta}x");
    await expect.poll(rows).toEqual(["xone = 1", "two = 2", "three = 3", ""]);
    await screen.rerender(
      <Editor
        relativePath={relativePath}
        contents={"xone = 1\ntwo = 2\nchanged = 3\n"}
        onContentsChange={onContentsChange}
      />,
    );
    await expect.poll(rows).toEqual(["xone = 1", "two = 2", "changed = 3", ""]);
    await userEvent.keyboard("{ControlOrMeta>}z{/ControlOrMeta}");
    await expect.poll(rows).toEqual(["one = 1", "two = 2", "changed = 3", ""]);
  });

  it("still shows an outside change on the line you just edited", async () => {
    const onContentsChange = vi.fn();
    const relativePath = fileName("overlap");
    await using screen = await render(
      <Editor
        relativePath={relativePath}
        contents={ORIGINAL}
        onContentsChange={onContentsChange}
      />,
      { router: false },
    );
    await expect.poll(rows).toEqual(["one = 1", "two = 2", "three = 3", ""]);
    await userEvent.click(textbox());
    await userEvent.keyboard("{ControlOrMeta>}{ArrowUp}{/ControlOrMeta}{ArrowRight}x");
    await expect.poll(rows).toEqual(["oxne = 1", "two = 2", "three = 3", ""]);
    await screen.rerender(
      <Editor
        relativePath={relativePath}
        contents={"replaced\ntwo = 2\nthree = 3\n"}
        onContentsChange={onContentsChange}
      />,
    );
    await expect.poll(rows).toEqual(["replaced", "two = 2", "three = 3", ""]);
  });

  it("shows a change made while its tab was closed", async () => {
    const onContentsChange = vi.fn();
    const relativePath = fileName("reopen");
    const closed = await render(
      <Editor
        relativePath={relativePath}
        contents={ORIGINAL}
        onContentsChange={onContentsChange}
      />,
      { router: false },
    );
    await expect.poll(rows).toEqual(["one = 1", "two = 2", "three = 3", ""]);
    await userEvent.click(textbox());
    await userEvent.keyboard("x");
    await expect.poll(() => rows().join("").includes("x")).toBe(true);
    await closed[Symbol.asyncDispose]();
    onContentsChange.mockClear();

    await using _reopened = await render(
      <Editor
        relativePath={relativePath}
        contents={"changed = 1\ntwo = 2\nthree = 3\n"}
        onContentsChange={onContentsChange}
      />,
      { router: false },
    );
    await expect.poll(rows).toEqual(["changed = 1", "two = 2", "three = 3", ""]);
    expect(onContentsChange).not.toHaveBeenCalled();
  });

  it("does not disturb a reopened file that did not change", async () => {
    const onContentsChange = vi.fn();
    const relativePath = fileName("same");
    const closed = await render(
      <Editor
        relativePath={relativePath}
        contents={ORIGINAL}
        onContentsChange={onContentsChange}
      />,
      { router: false },
    );
    await expect.poll(rows).toEqual(["one = 1", "two = 2", "three = 3", ""]);
    await userEvent.click(textbox());
    await userEvent.keyboard("{ControlOrMeta>}{ArrowUp}{/ControlOrMeta}x");
    await expect.poll(rows).toEqual(["xone = 1", "two = 2", "three = 3", ""]);
    await closed[Symbol.asyncDispose]();

    await using _reopened = await render(
      <Editor
        relativePath={relativePath}
        contents={"xone = 1\ntwo = 2\nthree = 3\n"}
        onContentsChange={onContentsChange}
      />,
      { router: false },
    );
    await expect.poll(rows).toEqual(["xone = 1", "two = 2", "three = 3", ""]);
    await userEvent.click(textbox());
    await userEvent.keyboard("{ControlOrMeta>}z{/ControlOrMeta}");
    await expect.poll(rows).toEqual(["one = 1", "two = 2", "three = 3", ""]);
  });

  it("shows an outside change that arrives while editing is off", async () => {
    const onContentsChange = vi.fn();
    const relativePath = fileName("blocked");
    await using screen = await render(
      <Editor
        relativePath={relativePath}
        contents={ORIGINAL}
        onContentsChange={onContentsChange}
      />,
      { router: false },
    );
    await expect.poll(rows).toEqual(["one = 1", "two = 2", "three = 3", ""]);
    await screen.rerender(
      <Editor
        relativePath={relativePath}
        contents={ORIGINAL}
        onContentsChange={onContentsChange}
        editingBlocked
      />,
    );
    await screen.rerender(
      <Editor
        relativePath={relativePath}
        contents={"changed = 1\ntwo = 2\nthree = 3\n"}
        onContentsChange={onContentsChange}
        editingBlocked
      />,
    );
    await expect.poll(rows).toEqual(["changed = 1", "two = 2", "three = 3", ""]);
    await screen.rerender(
      <Editor
        relativePath={relativePath}
        contents={"changed = 1\ntwo = 2\nthree = 3\n"}
        onContentsChange={onContentsChange}
      />,
    );
    await expect.poll(rows).toEqual(["changed = 1", "two = 2", "three = 3", ""]);
    await userEvent.click(textbox());
    await userEvent.keyboard("{ControlOrMeta>}{ArrowUp}{/ControlOrMeta}x");
    await expect.poll(rows).toEqual(["xchanged = 1", "two = 2", "three = 3", ""]);
  });

  it("shows an outside change in a file too large to rebase undo around", async () => {
    const onContentsChange = vi.fn();
    const relativePath = fileName("large");
    const filler = "# padding\n".repeat(30_000);
    await using screen = await render(
      <Editor
        relativePath={relativePath}
        contents={`one = 1\n${filler}`}
        onContentsChange={onContentsChange}
      />,
      { router: false },
    );
    await expect.poll(() => rows()[0]).toBe("one = 1");
    await screen.rerender(
      <Editor
        relativePath={relativePath}
        contents={`changed = 1\n${filler}`}
        onContentsChange={onContentsChange}
      />,
    );
    await expect.poll(() => rows()[0]).toBe("changed = 1");
    expect(onContentsChange).not.toHaveBeenCalled();
  });
});
