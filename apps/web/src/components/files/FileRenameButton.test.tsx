// @vitest-environment happy-dom
import { act, type ReactElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { EnvironmentId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({ rename: vi.fn() }));
vi.mock("~/state/projects", () => ({ projectEnvironment: { renameFile: Symbol("rename") } }));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => mocks.rename }));
vi.mock("~/components/ui/popover", async () => {
  const { createContext, useContext, cloneElement } = await import("react");
  const Context = createContext({ open: false, onOpenChange: (_open: boolean) => {} });
  return {
    Popover: ({
      children,
      ...props
    }: {
      children: ReactNode;
      open: boolean;
      onOpenChange: (open: boolean) => void;
    }) => <Context.Provider value={props}>{children}</Context.Provider>,
    PopoverTrigger: ({ render }: { render: ReactElement<{ onClick: () => void }> }) => {
      const context = useContext(Context);
      return cloneElement(render, { onClick: () => context.onOpenChange(true) });
    },
    PopoverPopup: ({ children }: { children: ReactNode }) =>
      useContext(Context).open ? children : null,
    PopoverTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  };
});

import { FileRenameButton, normalizeRenamePath } from "./FileRenameButton";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

describe("File rename publication barrier", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  const common = {
    environmentId: EnvironmentId.make("rename-synthetic"),
    cwd: "/synthetic-rename",
    relativePath: "notes.md",
    revision: "rA",
    disabled: false,
    label: "notes.md",
  };
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    mocks.rename.mockReset();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  async function enterDestination() {
    await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
    const input = container.querySelector<HTMLInputElement>("input")!;
    expect(input).not.toBeNull();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        input,
        "renamed.md",
      );
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  async function submit() {
    await act(async () => {
      container
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
  }

  it("holds the barrier through the RPC and rename callback, then releases it on success", async () => {
    const pending =
      deferred<
        ReturnType<
          typeof AsyncResult.success<{ destinationRelativePath: string; revision: string }>
        >
      >();
    mocks.rename.mockReturnValue(pending.promise);
    const release = vi.fn();
    const beforeRename = vi.fn(() => release);
    const renamed = vi.fn(() => {
      expect(release).not.toHaveBeenCalled();
    });
    await act(async () =>
      root.render(<FileRenameButton {...common} beforeRename={beforeRename} onRenamed={renamed} />),
    );
    await enterDestination();
    await submit();
    expect(beforeRename).toHaveBeenCalledTimes(1);
    expect(mocks.rename).toHaveBeenCalledWith({
      environmentId: common.environmentId,
      input: {
        cwd: common.cwd,
        relativePath: "notes.md",
        destinationRelativePath: "renamed.md",
        expectedRevision: "rA",
      },
    });
    expect(release).not.toHaveBeenCalled();
    await act(async () =>
      pending.resolve(
        AsyncResult.success({ destinationRelativePath: "renamed.md", revision: "rA" }),
      ),
    );
    expect(renamed).toHaveBeenCalledWith("renamed.md", "rA");
    expect(release).toHaveBeenCalledTimes(1);
    expect(container.querySelector("form")).toBeNull();
  });

  it("releases the barrier on failure and leaves the rename available to correct", async () => {
    const release = vi.fn();
    mocks.rename.mockResolvedValue(AsyncResult.failure(Cause.fail({ failure: "path_exists" })));
    const renamed = vi.fn();
    await act(async () =>
      root.render(
        <FileRenameButton {...common} beforeRename={() => release} onRenamed={renamed} />,
      ),
    );
    await enterDestination();
    await submit();
    expect(release).toHaveBeenCalledTimes(1);
    expect(renamed).not.toHaveBeenCalled();
    expect(container.querySelector("[role=alert]")?.textContent).toBe(
      "A file already exists at that path.",
    );
    expect(container.querySelector<HTMLButtonElement>("button[type=submit]")?.disabled).toBe(false);
  });

  it("does not rename a file whose prefilled path is submitted untouched", async () => {
    // The name ends in a space. Treated as typed text it would be trimmed to
    // a different name, and the file renamed without anyone asking.
    const beforeRename = vi.fn(() => vi.fn());
    await act(async () =>
      root.render(
        <FileRenameButton
          {...common}
          relativePath="drafts/notes.md "
          label="notes.md "
          beforeRename={beforeRename}
          onRenamed={vi.fn()}
        />,
      ),
    );
    await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
    expect(container.querySelector<HTMLInputElement>("input")!.value).toBe("drafts/notes.md ");

    await submit();

    expect(beforeRename).not.toHaveBeenCalled();
    expect(mocks.rename).not.toHaveBeenCalled();
    expect(container.querySelector("input")).toBeNull();
  });

  it("does not dispatch when the clean-state barrier cannot be acquired", async () => {
    const beforeRename = vi.fn(() => null);
    await act(async () =>
      root.render(<FileRenameButton {...common} beforeRename={beforeRename} onRenamed={vi.fn()} />),
    );
    await enterDestination();
    await submit();
    expect(beforeRename).toHaveBeenCalledTimes(1);
    expect(mocks.rename).not.toHaveBeenCalled();
    expect(container.querySelector("[role=alert]")?.textContent).toContain(
      "Finish the current file operation",
    );
  });

  it("rechecks disabled state even if the popup was opened while the file was clean", async () => {
    const beforeRename = vi.fn(() => vi.fn());
    const renamed = vi.fn();
    await act(async () =>
      root.render(<FileRenameButton {...common} beforeRename={beforeRename} onRenamed={renamed} />),
    );
    await enterDestination();
    await act(async () =>
      root.render(
        <FileRenameButton {...common} disabled beforeRename={beforeRename} onRenamed={renamed} />,
      ),
    );
    expect(container.querySelector<HTMLButtonElement>("button[type=submit]")?.disabled).toBe(true);
    await submit();
    expect(beforeRename).not.toHaveBeenCalled();
    expect(mocks.rename).not.toHaveBeenCalled();
  });
  it("renames a file it cannot read whole without a revision", async () => {
    mocks.rename.mockResolvedValue(
      AsyncResult.success({
        relativePath: "figure.pdf",
        destinationRelativePath: "renamed.md",
        revision: "rB",
      }),
    );
    const onRenamed = vi.fn();
    await act(async () =>
      root.render(
        <FileRenameButton
          {...common}
          relativePath="figure.pdf"
          label="figure.pdf"
          revision={null}
          onRenamed={onRenamed}
        />,
      ),
    );
    await enterDestination();
    await submit();
    expect(mocks.rename).toHaveBeenCalledOnce();
    expect(mocks.rename.mock.calls[0]![0].input).not.toHaveProperty("expectedRevision");
    expect(onRenamed).toHaveBeenCalledWith("renamed.md", "rB");
  });

  it("shows what else refers to the file under the field", async () => {
    await act(async () =>
      root.render(
        <FileRenameButton
          {...common}
          relativePath="sections/intro.tex"
          label="intro.tex"
          notice="paper.tex includes this file."
          onRenamed={() => {}}
        />,
      ),
    );
    await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
    expect(container.textContent).toContain("paper.tex includes this file.");
  });
});

describe("normalizeRenamePath", () => {
  it("keeps the file's extension when the new name has none", () => {
    expect(normalizeRenamePath("chapter", "sections/intro.tex")).toBe("chapter.tex");
    expect(normalizeRenamePath(" sections/one ", "sections/intro.tex")).toBe("sections/one.tex");
    expect(normalizeRenamePath("intro.md", "sections/intro.tex")).toBe("intro.md");
    expect(normalizeRenamePath("Makefile2", "Makefile")).toBe("Makefile2");
    expect(normalizeRenamePath(".env", "main.ts")).toBe(".env");
    expect(normalizeRenamePath("new.", "main.ts")).toBeNull();
  });
  it("refuses paths outside the workspace or with empty parts", () => {
    for (const path of ["", "/etc/x", "../x.tex", "a//b.tex", "C:/x.tex", "a/./b"]) {
      expect(normalizeRenamePath(path, "x.tex")).toBeNull();
    }
  });
});
