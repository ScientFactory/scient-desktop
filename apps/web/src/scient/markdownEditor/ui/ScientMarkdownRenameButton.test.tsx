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

import { ScientMarkdownRenameButton } from "./ScientMarkdownRenameButton";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

describe("Markdown rename publication barrier", () => {
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
      root.render(
        <ScientMarkdownRenameButton {...common} beforeRename={beforeRename} onRenamed={renamed} />,
      ),
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
        <ScientMarkdownRenameButton {...common} beforeRename={() => release} onRenamed={renamed} />,
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

  it("does not dispatch when the clean-state barrier cannot be acquired", async () => {
    const beforeRename = vi.fn(() => null);
    await act(async () =>
      root.render(
        <ScientMarkdownRenameButton {...common} beforeRename={beforeRename} onRenamed={vi.fn()} />,
      ),
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
      root.render(
        <ScientMarkdownRenameButton {...common} beforeRename={beforeRename} onRenamed={renamed} />,
      ),
    );
    await enterDestination();
    await act(async () =>
      root.render(
        <ScientMarkdownRenameButton
          {...common}
          disabled
          beforeRename={beforeRename}
          onRenamed={renamed}
        />,
      ),
    );
    expect(container.querySelector<HTMLButtonElement>("button[type=submit]")?.disabled).toBe(true);
    await submit();
    expect(beforeRename).not.toHaveBeenCalled();
    expect(mocks.rename).not.toHaveBeenCalled();
  });
});
