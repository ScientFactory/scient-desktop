import {
  render as _fixtureRender,
  type Screen,
  fakeTimers as _fixtureFakeTimers,
  act,
} from "../../../test/render";
import { type ReactElement, type ReactNode } from "react";

import { EnvironmentId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({ rename: vi.fn(), read: vi.fn(), resolve: vi.fn() }));
vi.mock("~/state/projects", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/state/projects")>();
  return {
    ...actual,
    projectEnvironment: {
      ...actual.projectEnvironment,
      renameFile: "rename",
      readFileOrdered: "read",
      resolveFileMutation: "resolve",
    },
  };
});
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
  async function _setupFixture0(_fixture: _Fixture) {
    _fixture.stack.use(_fixtureFakeTimers());
    for (const mock of Object.values(mocks)) mock.mockReset();
    _fixture.container = document.createElement("div");
    document.body.append(_fixture.container);
    _fixture.root0 = _fixture.stack.use(
      await _fixtureRender(null, { container: _fixture.container, router: false }),
    );
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
  }
  async function _cleanupFixture1(_fixture: _Fixture) {
    await act(async () => await _fixture.root0.unmount());
    for (const lease of leases) lease.release();
    _fixture.container.remove();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
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
  async function render(_fixture: _Fixture, adapter: GenericFileRenameJournal, disabled = false) {
    await act(
      async () =>
        await _fixture.root0.rerender(
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
  async function enterDestination(_fixture: _Fixture) {
    await act(async () => _fixture.container.querySelector<HTMLButtonElement>("button")!.click());
    const input = _fixture.container.querySelector<HTMLInputElement>("input")!;
    if (input.disabled) return;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        input,
        destination.relativePath,
      );
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  async function submit(_fixture: _Fixture) {
    await act(async () =>
      _fixture.container
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
  }

  it("follows a fresh acknowledged rename only after its exact durable journal commits", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await render(_fixture, await journal());
    await enterDestination(_fixture);
    await submit(_fixture);
    expect(visiblePath).toBe(destination.relativePath);
    expect(disk.get(common.relativePath)).toBeUndefined();
    expect(disk.get(destination.relativePath)).toEqual({ source: "A", revision: "rA" });
    expect(records.get(projectFileOperationKey(destination))?.draftSource).toBe("A");
    expect(_fixture.container.querySelector("form")).toBeNull();
  });

  it.each(["CAS", "throw"] as const)(
    "follows the actual moved file even when obsolete source cleanup fails at %s",
    async (mode) => {
      await using _fixture = _createFixture();
      _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
      await _setupFixture0(_fixture);

      const adapter = await journal();
      leases[0]!.change("C");
      // Freeze a clean rename before newer input is typed during transport.
      await leases[0]!.flush();
      mocks.rename.mockImplementationOnce(async () => {
        leases[0]!.change("D");
        disk.set(destination.relativePath, disk.get(common.relativePath)!);
        disk.delete(common.relativePath);
        return AsyncResult.success({
          destinationRelativePath: destination.relativePath,
          revision: "r-saved",
        });
      });
      controls.sourceCleanup = mode;
      await render(_fixture, adapter);
      await enterDestination(_fixture);
      await submit(_fixture);
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
      expect(_fixture.container.querySelector("form")).toBeNull();
    },
  );

  it("unlocks a definitively rejected destination and admits a fresh name with a fresh identity", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const adapter = await journal();
    const identities: string[] = [];
    mocks.rename.mockImplementationOnce(async ({ input }: { input: { mutationId: string } }) => {
      identities.push(input.mutationId);
      return AsyncResult.failure(Cause.fail({ failure: "path_exists" }));
    });
    await render(_fixture, adapter);
    await enterDestination(_fixture);
    await submit(_fixture);
    expect(visiblePath).toBe(common.relativePath);
    expect(adapter.pendingRename).toBeNull();
    expect(records.get(projectFileOperationKey(from))?.renameIntent).toBeNull();
    const input = _fixture.container.querySelector<HTMLInputElement>("input")!;
    expect(input.disabled).toBe(false);
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        input,
        "different.md",
      );
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await submit(_fixture);
    expect(visiblePath).toBe("different.md");
    expect(disk.get("different.md")).toEqual({ source: "A", revision: "rA" });
    const committed = records.get(
      projectFileOperationKey({ ...destination, relativePath: "different.md" }),
    )!;
    expect(committed.renameIntent?.mutationId).not.toBe(identities[0]);
    expect(committed.renameIntent?.destination.relativePath).toBe("different.md");
  });

  it("keeps the rejected name locked when durable refusal clearing fails", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const adapter = await journal();
    mocks.rename.mockImplementationOnce(async () => {
      controls.fail = true;
      return AsyncResult.failure(Cause.fail({ failure: "path_exists" }));
    });
    await render(_fixture, adapter);
    await enterDestination(_fixture);
    await submit(_fixture);
    expect(visiblePath).toBe(common.relativePath);
    expect(adapter.pendingRename?.destination.relativePath).toBe(destination.relativePath);
    expect(_fixture.container.querySelector<HTMLInputElement>("input")?.disabled).toBe(true);
    await submit(_fixture);
    expect(disk.get(common.relativePath)).toEqual({ source: "A", revision: "rA" });
    expect(disk.has(destination.relativePath)).toBe(false);
    expect(mocks.rename).toHaveBeenCalledTimes(1);
  });

  it("retains the input and namespace when pre-dispatch CAS fails", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await render(_fixture, await journal());
    controls.fail = true;
    await enterDestination(_fixture);
    await submit(_fixture);
    expect(visiblePath).toBe(common.relativePath);
    expect(disk.get(common.relativePath)).toEqual({ source: "A", revision: "rA" });
    expect(disk.get(destination.relativePath)).toBeUndefined();
    expect(_fixture.container.querySelector<HTMLInputElement>("input")?.value).toBe(
      destination.relativePath,
    );
  });

  it("reconstructs a lost reply and explicitly replays the original ID and destination while ordinary renaming is disabled", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const original = await journal();
    await render(_fixture, original);
    controls.loseReply = true;
    await enterDestination(_fixture);
    await submit(_fixture);
    const intent = records.get(projectFileOperationKey(from))!.renameIntent!;
    expect(visiblePath).toBe(common.relativePath);
    await act(async () => await _fixture.root0.unmount());
    _fixture.root0 = _fixture.stack.use(
      await _fixtureRender(null, { container: _fixture.container, router: false }),
    );
    const reconstructed = await journal();
    expect(reconstructed.pendingRename).toEqual(intent);
    controls.loseReply = false;
    await render(_fixture, reconstructed, true);
    await enterDestination(_fixture);
    expect(_fixture.container.querySelector<HTMLInputElement>("input")?.value).toBe(
      intent.destination.relativePath,
    );
    expect(_fixture.container.querySelector<HTMLInputElement>("input")?.disabled).toBe(true);
    await submit(_fixture);
    expect(visiblePath).toBe(destination.relativePath);
    expect(disk.get(destination.relativePath)).toEqual({ source: "A", revision: "rA" });
    expect(records.get(projectFileOperationKey(destination))?.baselineSource).toBe("A");
  });

  it("does not follow an ACK whose destination journal CAS failed; a retry settles the cached receipt without another namespace dispatch", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const adapter = await journal();
    await render(_fixture, adapter);
    controls.failDestination = true;
    await enterDestination(_fixture);
    await submit(_fixture);
    expect(visiblePath).toBe(common.relativePath);
    expect(records.get(projectFileOperationKey(from))?.renameIntent?.acknowledgement).toEqual({
      destinationRelativePath: destination.relativePath,
      revision: "rA",
    });
    controls.failDestination = false;
    mocks.rename.mockImplementation(async () => {
      throw new Error("The cached receipt must not redispatch");
    });
    await submit(_fixture);
    expect(visiblePath).toBe(destination.relativePath);
    expect(disk.get(destination.relativePath)).toEqual({ source: "A", revision: "rA" });
  });

  it("rechecks disabled state after opening the rename field and keeps its input unchanged", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const adapter = await journal();
    await render(_fixture, adapter);
    await enterDestination(_fixture);
    await render(_fixture, adapter, true);
    await submit(_fixture);
    expect(visiblePath).toBe(common.relativePath);
    expect(disk.get(common.relativePath)?.source).toBe("A");
    expect(disk.get(destination.relativePath)).toBeUndefined();
    expect(_fixture.container.querySelector<HTMLInputElement>("input")?.value).toBe(
      destination.relativePath,
    );
  });

  it.each(["binary", "truncated", "lost-binary"] as const)(
    "keeps supported %s header renaming source-free, including reconstructed receipt replay",
    async (mode) => {
      await using _fixture = _createFixture();
      _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
      await _setupFixture0(_fixture);

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
      const mountMetadata = async () =>
        await act(
          async () =>
            await _fixture.root0.rerender(
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
      await enterDestination(_fixture);
      await submit(_fixture);
      if (mode === "lost-binary") {
        expect(visiblePath).toBe(originalPath);
        const original = await metadataStore.readMetadataRename!(projectFileOperationKey(target));
        expect(original?.intent.destination.relativePath).toBe(destination.relativePath);
        await act(async () => await _fixture.root0.unmount());
        _fixture.root0 = _fixture.stack.use(
          await _fixtureRender(null, { container: _fixture.container, router: false }),
        );
        loseReply = false;
        await mountMetadata();
        await enterDestination(_fixture);
        expect(_fixture.container.querySelector<HTMLInputElement>("input")?.disabled).toBe(true);
        await submit(_fixture);
      }
      expect(visiblePath).toBe(destination.relativePath);
      expect(namespace.get(originalPath)).toBeUndefined();
      expect(namespace.get(destination.relativePath)).toBe(opaque);
      expect(_fixture.container.querySelector("form")).toBeNull();
    },
  );
});

describe("normalizeRenamePath", () => {
  it("keeps the file's extension when the new name has none", async () => {
    await using _fixture = _createFixture();

    expect(normalizeRenamePath("chapter", "sections/intro.tex")).toBe("chapter.tex");
    expect(normalizeRenamePath(" sections/one ", "sections/intro.tex")).toBe("sections/one.tex");
    expect(normalizeRenamePath("intro.md", "sections/intro.tex")).toBe("intro.md");
    expect(normalizeRenamePath("Makefile2", "Makefile")).toBe("Makefile2");
    expect(normalizeRenamePath(".env", "main.ts")).toBe(".env");
    expect(normalizeRenamePath("new.", "main.ts")).toBeNull();
  });
  it("refuses paths outside the workspace or with empty parts", async () => {
    await using _fixture = _createFixture();

    for (const path of ["", "/etc/x", "../x.tex", "a//b.tex", "C:/x.tex", "a/./b"]) {
      expect(normalizeRenamePath(path, "x.tex")).toBeNull();
    }
  });
});

function _createFixture() {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    container: undefined! as HTMLDivElement,
    stack,
    cleanup,
    root0: undefined! as Screen,
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
