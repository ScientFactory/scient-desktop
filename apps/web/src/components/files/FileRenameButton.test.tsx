// @vitest-environment happy-dom
import { act, type ReactElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EnvironmentId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({ rename: vi.fn(), read: vi.fn(), resolve: vi.fn() }));
vi.mock("~/state/projects", () => ({
  projectEnvironment: {
    renameFile: "rename",
    readFileOrdered: "read",
    resolveFileMutation: "resolve",
  },
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: keyof typeof mocks) => mocks[command],
}));
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
import { projectFileOperationKey } from "@t3tools/client-runtime/state/projects";
import type {
  MarkdownDraftCheckpoint,
  MarkdownDraftCheckpointStore,
  MetadataFileRenameCheckpoint,
} from "~/scient/markdownEditor/persistence/markdownDraftCheckpoint";
import type { GenericFileRenameJournal } from "./useFileSaveCoordinator";
import {
  WorkspaceFileSessionRegistry,
  type WorkspaceFileSessionLease,
} from "./workspaceFileSessionRegistry";

describe("File rename durable admission and recovery", () => {
  let container: HTMLDivElement;
  let root: Root;
  const common = {
    environmentId: EnvironmentId.make("rename-synthetic"),
    cwd: "/synthetic-rename",
    relativePath: "notes.md",
    revision: "rA",
    disabled: false,
    label: "notes.md",
  };
  const destination = {
    environmentId: common.environmentId,
    cwd: common.cwd,
    relativePath: "renamed.md",
  };
  const from = {
    environmentId: common.environmentId,
    cwd: common.cwd,
    relativePath: common.relativePath,
  };
  let records: Map<string, MarkdownDraftCheckpoint>;
  let disk: Map<string, { source: string; revision: string }>;
  let store: MarkdownDraftCheckpointStore;
  let controls: {
    fail: boolean;
    failDestination: boolean;
    loseReply: boolean;
    sourceCleanup: "CAS" | "throw" | null;
  };
  let leases: WorkspaceFileSessionLease[];
  let visiblePath: string;
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.useFakeTimers();
    for (const mock of Object.values(mocks)) mock.mockReset();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    leases = [];
    visiblePath = common.relativePath;
    records = new Map();
    disk = new Map([[common.relativePath, { source: "A", revision: "rA" }]]);
    controls = { fail: false, failDestination: false, loseReply: false, sourceCleanup: null };
    store = {
      read: async (key) => records.get(key),
      replace: async (key, token, next) => {
        if (
          controls.fail ||
          (controls.failDestination && key === projectFileOperationKey(destination))
        )
          return false;
        if (
          key === projectFileOperationKey(from) &&
          next === undefined &&
          controls.sourceCleanup !== null
        ) {
          if (controls.sourceCleanup === "throw") throw new Error("Retirement storage unavailable");
          return false;
        }
        if (records.get(key)?.token !== token) return false;
        if (next) records.set(key, next);
        else records.delete(key);
        return true;
      },
    };
    const receipts = new Map<string, { destinationRelativePath: string; revision: string }>();
    mocks.rename.mockImplementation(
      async ({
        input,
      }: {
        input: {
          relativePath: string;
          destinationRelativePath: string;
          expectedRevision: string;
          mutationId: string;
        };
      }) => {
        const journal = records.get(projectFileOperationKey(from));
        expect(journal?.renameIntent?.mutationId).toBe(input.mutationId);
        expect(journal?.renameIntent?.source).toBe("A");
        let receipt = receipts.get(input.mutationId);
        if (!receipt) {
          const original = disk.get(input.relativePath);
          if (
            original?.revision !== input.expectedRevision ||
            disk.has(input.destinationRelativePath)
          )
            return AsyncResult.failure(Cause.fail({ failure: "revision_conflict" }));
          disk.set(input.destinationRelativePath, original);
          disk.delete(input.relativePath);
          receipt = {
            destinationRelativePath: input.destinationRelativePath,
            revision: original.revision,
          };
          receipts.set(input.mutationId, receipt);
        }
        if (controls.loseReply) throw new Error("Reply lost after namespace commit");
        return AsyncResult.success(receipt);
      },
    );
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    for (const lease of leases) lease.release();
    container.remove();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  async function journal() {
    const lease = new WorkspaceFileSessionRegistry<{ revision: string }, unknown>().acquire({
      key: projectFileOperationKey(from),
      initialSource: "A",
      initialRevision: "rA",
      journalStore: store,
      debounceMs: 500,
      persist: async (source) => {
        disk.set(visiblePath, { source, revision: "r-saved" });
        return AsyncResult.success({ revision: "r-saved" });
      },
      revisionFromResult: (value) => value.revision,
    });
    leases.push(lease);
    expect(await lease.ready()).toBe(true);
    const adapter: GenericFileRenameJournal = {
      get pendingRename() {
        return lease.getRenameIntent();
      },
      beginRename: (to) => lease.beginRename(from, { ...destination, relativePath: to }),
      isCurrent: lease.isRenameCurrent,
      acknowledgeRename: lease.acknowledgeRename,
      rejectRename: lease.rejectRename,
    };
    return adapter;
  }
  async function render(adapter: GenericFileRenameJournal, disabled = false) {
    await act(async () =>
      root.render(
        <FileRenameButton
          {...common}
          disabled={disabled}
          renameJournal={adapter}
          onRenamed={(path) => {
            visiblePath = path;
          }}
        />,
      ),
    );
  }
  async function enterDestination() {
    await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
    const input = container.querySelector<HTMLInputElement>("input")!;
    if (input.disabled) return;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        input,
        destination.relativePath,
      );
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  async function submit() {
    await act(async () =>
      container
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
  }

  it("follows a fresh acknowledged rename only after its exact durable journal commits", async () => {
    await render(await journal());
    await enterDestination();
    await submit();
    expect(visiblePath).toBe(destination.relativePath);
    expect(disk.get(common.relativePath)).toBeUndefined();
    expect(disk.get(destination.relativePath)).toEqual({ source: "A", revision: "rA" });
    expect(records.get(projectFileOperationKey(destination))?.draftSource).toBe("A");
    expect(container.querySelector("form")).toBeNull();
  });

  it.each(["CAS", "throw"] as const)(
    "follows the actual moved file even when obsolete source cleanup fails at %s",
    async (mode) => {
      const adapter = await journal();
      leases[0]!.change("C");
      // Freeze a clean rename before newer input is typed during transport.
      await leases[0]!.flush();
      mocks.rename.mockImplementationOnce(async ({ input }: { input: { mutationId: string } }) => {
        leases[0]!.change("D");
        disk.set(destination.relativePath, disk.get(common.relativePath)!);
        disk.delete(common.relativePath);
        return AsyncResult.success({
          destinationRelativePath: destination.relativePath,
          revision: "r-saved",
        });
      });
      controls.sourceCleanup = mode;
      await render(adapter);
      await enterDestination();
      await submit();
      expect(visiblePath).toBe(destination.relativePath);
      expect(disk.has(common.relativePath)).toBe(false);
      expect(disk.get(destination.relativePath)?.source).toBe("C");
      expect(records.get(projectFileOperationKey(destination))).toMatchObject({
        baselineSource: "C",
        draftSource: "D",
      });
      expect(records.get(projectFileOperationKey(from))).toMatchObject({
        draftSource: "D",
        renameIntent: {
          acknowledgement: {
            destinationRelativePath: destination.relativePath,
            revision: "r-saved",
          },
        },
      });
      expect(container.querySelector("form")).toBeNull();
    },
  );

  it("unlocks a definitively rejected destination and admits a fresh name with a fresh identity", async () => {
    const adapter = await journal();
    const identities: string[] = [];
    mocks.rename.mockImplementationOnce(async ({ input }: { input: { mutationId: string } }) => {
      identities.push(input.mutationId);
      return AsyncResult.failure(Cause.fail({ failure: "path_exists" }));
    });
    await render(adapter);
    await enterDestination();
    await submit();
    expect(visiblePath).toBe(common.relativePath);
    expect(adapter.pendingRename).toBeNull();
    expect(records.get(projectFileOperationKey(from))?.renameIntent).toBeNull();
    const input = container.querySelector<HTMLInputElement>("input")!;
    expect(input.disabled).toBe(false);
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        input,
        "different.md",
      );
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await submit();
    expect(visiblePath).toBe("different.md");
    expect(disk.get("different.md")).toEqual({ source: "A", revision: "rA" });
    const committed = records.get(
      projectFileOperationKey({ ...destination, relativePath: "different.md" }),
    )!;
    expect(committed.renameIntent?.mutationId).not.toBe(identities[0]);
    expect(committed.renameIntent?.destination.relativePath).toBe("different.md");
  });

  it("keeps the rejected name locked when durable refusal clearing fails", async () => {
    const adapter = await journal();
    mocks.rename.mockImplementationOnce(async () => {
      controls.fail = true;
      return AsyncResult.failure(Cause.fail({ failure: "path_exists" }));
    });
    await render(adapter);
    await enterDestination();
    await submit();
    expect(visiblePath).toBe(common.relativePath);
    expect(adapter.pendingRename?.destination.relativePath).toBe(destination.relativePath);
    expect(container.querySelector<HTMLInputElement>("input")?.disabled).toBe(true);
    await submit();
    expect(disk.get(common.relativePath)).toEqual({ source: "A", revision: "rA" });
    expect(disk.has(destination.relativePath)).toBe(false);
    expect(mocks.rename).toHaveBeenCalledTimes(1);
  });

  it("retains the input and namespace when pre-dispatch CAS fails", async () => {
    await render(await journal());
    controls.fail = true;
    await enterDestination();
    await submit();
    expect(visiblePath).toBe(common.relativePath);
    expect(disk.get(common.relativePath)).toEqual({ source: "A", revision: "rA" });
    expect(disk.get(destination.relativePath)).toBeUndefined();
    expect(container.querySelector<HTMLInputElement>("input")?.value).toBe(
      destination.relativePath,
    );
  });

  it("reconstructs a lost reply and explicitly replays the original ID and destination while ordinary renaming is disabled", async () => {
    const original = await journal();
    await render(original);
    controls.loseReply = true;
    await enterDestination();
    await submit();
    const intent = records.get(projectFileOperationKey(from))!.renameIntent!;
    expect(visiblePath).toBe(common.relativePath);
    await act(async () => root.unmount());
    root = createRoot(container);
    const reconstructed = await journal();
    expect(reconstructed.pendingRename).toEqual(intent);
    controls.loseReply = false;
    await render(reconstructed, true);
    await enterDestination();
    expect(container.querySelector<HTMLInputElement>("input")?.value).toBe(
      intent.destination.relativePath,
    );
    expect(container.querySelector<HTMLInputElement>("input")?.disabled).toBe(true);
    await submit();
    expect(visiblePath).toBe(destination.relativePath);
    expect(disk.get(destination.relativePath)).toEqual({ source: "A", revision: "rA" });
    expect(records.get(projectFileOperationKey(destination))?.baselineSource).toBe("A");
  });

  it("does not follow an ACK whose destination journal CAS failed; a retry settles the cached receipt without another namespace dispatch", async () => {
    const adapter = await journal();
    await render(adapter);
    controls.failDestination = true;
    await enterDestination();
    await submit();
    expect(visiblePath).toBe(common.relativePath);
    expect(records.get(projectFileOperationKey(from))?.renameIntent?.acknowledgement).toEqual({
      destinationRelativePath: destination.relativePath,
      revision: "rA",
    });
    controls.failDestination = false;
    mocks.rename.mockImplementation(async () => {
      throw new Error("The cached receipt must not redispatch");
    });
    await submit();
    expect(visiblePath).toBe(destination.relativePath);
    expect(disk.get(destination.relativePath)).toEqual({ source: "A", revision: "rA" });
  });

  it("rechecks disabled state after opening the rename field and keeps its input unchanged", async () => {
    const adapter = await journal();
    await render(adapter);
    await enterDestination();
    await render(adapter, true);
    await submit();
    expect(visiblePath).toBe(common.relativePath);
    expect(disk.get(common.relativePath)?.source).toBe("A");
    expect(disk.get(destination.relativePath)).toBeUndefined();
    expect(container.querySelector<HTMLInputElement>("input")?.value).toBe(
      destination.relativePath,
    );
  });

  it.each(["binary", "truncated", "lost-binary"] as const)(
    "keeps supported %s header renaming source-free, including reconstructed receipt replay",
    async (mode) => {
      const originalPath = mode === "truncated" ? "oversized.md" : "figure.pdf";
      visiblePath = originalPath;
      const target = { ...from, relativePath: originalPath };
      const opaque =
        mode === "truncated" ? new Uint8Array(512).fill(65) : Uint8Array.of(0, 255, 128, 0);
      const namespace = new Map([[originalPath, opaque]]);
      const rows = new Map<string, MarkdownDraftCheckpoint | MetadataFileRenameCheckpoint>();
      const metadataStore: MarkdownDraftCheckpointStore = {
        read: async (key) => {
          const row = rows.get(key);
          if (row && "kind" in row) throw new Error("Metadata owner");
          return row;
        },
        replace: async (key, token, next) => {
          const row = rows.get(key);
          if (row && "kind" in row) throw new Error("Metadata owner");
          if (row?.token !== token) return false;
          if (next) rows.set(key, next);
          else rows.delete(key);
          return true;
        },
        readMetadataRename: async (key) => {
          const row = rows.get(key);
          if (row && !("kind" in row)) throw new Error("Source owner");
          return row;
        },
        replaceMetadataRename: async (key, token, next) => {
          const row = rows.get(key);
          if (row && !("kind" in row)) throw new Error("Source owner");
          if (row?.token !== token) return false;
          if (next) rows.set(key, next);
          else rows.delete(key);
          return true;
        },
      };
      const receipts = new Map<string, { destinationRelativePath: string; revision: string }>();
      let loseReply = mode === "lost-binary";
      mocks.rename.mockImplementation(
        async ({
          input,
        }: {
          input: {
            relativePath: string;
            destinationRelativePath: string;
            mutationId: string;
            expectedRevision?: string;
          };
        }) => {
          const row = rows.get(projectFileOperationKey(target));
          expect(row && "kind" in row ? row.intent.mutationId : null).toBe(input.mutationId);
          expect(input).not.toHaveProperty("expectedRevision");
          expect(row).not.toHaveProperty("baselineSource");
          let receipt = receipts.get(input.mutationId);
          if (!receipt) {
            const bytes = namespace.get(input.relativePath);
            if (!bytes || namespace.has(input.destinationRelativePath))
              return AsyncResult.failure(Cause.fail({ failure: "revision_conflict" }));
            namespace.set(input.destinationRelativePath, bytes);
            namespace.delete(input.relativePath);
            receipt = {
              destinationRelativePath: input.destinationRelativePath,
              revision: "opaque-revision",
            };
            receipts.set(input.mutationId, receipt);
          }
          if (loseReply) throw new Error("Lost opaque namespace reply");
          return AsyncResult.success(receipt);
        },
      );
      const mountMetadata = () =>
        act(async () =>
          root.render(
            <FileRenameButton
              {...common}
              metadataOnly
              metadataStore={metadataStore}
              relativePath={originalPath}
              label={originalPath}
              revision={null}
              onRenamed={(path) => {
                visiblePath = path;
              }}
            />,
          ),
        );
      await mountMetadata();
      await enterDestination();
      await submit();
      if (mode === "lost-binary") {
        expect(visiblePath).toBe(originalPath);
        const original = await metadataStore.readMetadataRename!(projectFileOperationKey(target));
        expect(original?.intent.destination.relativePath).toBe(destination.relativePath);
        await act(async () => root.unmount());
        root = createRoot(container);
        loseReply = false;
        await mountMetadata();
        await enterDestination();
        expect(container.querySelector<HTMLInputElement>("input")?.disabled).toBe(true);
        await submit();
      }
      expect(visiblePath).toBe(destination.relativePath);
      expect(namespace.get(originalPath)).toBeUndefined();
      expect(namespace.get(destination.relativePath)).toBe(opaque);
      expect(container.querySelector("form")).toBeNull();
    },
  );
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
