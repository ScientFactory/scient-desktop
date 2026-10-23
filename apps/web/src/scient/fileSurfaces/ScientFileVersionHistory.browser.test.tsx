import { render as _fixtureRender, type Screen, act } from "../../../test/render";

import type { ReactElement, ReactNode } from "react";

import { EnvironmentId, ProjectReadFileError } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";
import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex } from "@noble/hashes/utils";

const commands = vi.hoisted(() => ({
  list: vi.fn(),
  discard: vi.fn(),
  read: vi.fn(),
  write: vi.fn(),
  resolve: vi.fn(),
}));
vi.mock("~/state/projects", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/state/projects")>();
  return {
    ...actual,
    projectEnvironment: {
      ...actual.projectEnvironment,
      listFileVersions: "list",
      discardFileVersion: "discard",
      readFileOrdered: "read",
      writeFile: "write",
      resolveFileMutation: "resolve",
    },
  };
});
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: keyof typeof commands) => commands[command],
}));
vi.mock("~/components/files/projectFilesQueryState", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/components/files/projectFilesQueryState")>()),
  refreshProjectEntriesQuery: vi.fn(),
}));
vi.mock("~/components/ui/popover", async () => {
  const { createContext, useContext, useState, cloneElement } = await import("react");
  const Context = createContext({ open: false, onOpenChange: (_open: boolean) => {} });
  return {
    Popover: ({
      children,
      onOpenChange,
    }: {
      children: ReactNode;
      onOpenChange: (open: boolean) => void;
    }) => {
      const [open, setOpen] = useState(false);
      return (
        <Context.Provider
          value={{
            open,
            onOpenChange: (next) => {
              setOpen(next);
              onOpenChange(next);
            },
          }}
        >
          {children}
        </Context.Provider>
      );
    },
    PopoverTrigger: ({
      render,
      children,
    }: {
      render: ReactElement<{ onClick: () => void }>;
      children: ReactNode;
    }) => {
      const context = useContext(Context);
      return cloneElement(render, { onClick: () => context.onOpenChange(!context.open) }, children);
    },
    PopoverPopup: ({ children }: { children: ReactNode }) =>
      useContext(Context).open ? children : null,
    PopoverTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  };
});

import { ScientFileVersionHistory } from "./ScientFileVersionHistory";

const version = {
  versionId: "version-synthetic",
  mutationId: "mutation-synthetic",
  retainedPath: "/retained/notes.md",
  revision: null,
  byteLength: 21,
  retainedAt: 1_750_000_000_000,
};
const history = { versions: [version], retainedBytes: 21, limitBytes: null, attention: null };

function readSnapshot(contents: string) {
  const bytes = new TextEncoder().encode(contents);
  return {
    relativePath: "notes.md",
    contents,
    revision: `sha256:${bytesToHex(sha256(bytes))}`,
    byteLength: bytes.byteLength,
    truncated: false,
  };
}

describe("retained file history actions", () => {
  const open = vi.fn();
  async function _setupFixture0(_fixture: _Fixture) {
    for (const command of Object.values(commands)) command.mockReset();
    commands.list.mockResolvedValue(AsyncResult.success(history));
    commands.discard.mockResolvedValue(AsyncResult.success({ versionId: version.versionId }));
    commands.read.mockResolvedValue(AsyncResult.success(readSnapshot("Retained text")));
    commands.write.mockResolvedValue(
      AsyncResult.success({ relativePath: "copy.md", revision: "rCopy" }),
    );
    _fixture.host = document.createElement("div");
    document.body.append(_fixture.host);
    _fixture.root0 = _fixture.stack.use(
      await _fixtureRender(null, { container: _fixture.host, router: false }),
    );
    open.mockReset();
  }
  async function _cleanupFixture1(_fixture: _Fixture) {
    await act(async () => await _fixture.root0.unmount());
    _fixture.host.remove();
    vi.unstubAllGlobals();
  }
  async function mount(
    _fixture: _Fixture,
    canWrite = true,
    onAcceptCurrent?: (recoveryId: string, currentRevision: string | null) => Promise<boolean>,
    canAcceptCurrent = true,
  ) {
    await act(
      async () =>
        await _fixture.root0.rerender(
          <ScientFileVersionHistory
            environmentId={EnvironmentId.make("history-test")}
            cwd="/synthetic"
            relativePath="notes.md"
            canWrite={canWrite}
            onOpenFile={open}
            {...(onAcceptCurrent ? { onAcceptCurrent } : {})}
            canAcceptCurrent={canAcceptCurrent}
          />,
        ),
    );
    await act(async () =>
      _fixture.host
        .querySelector<HTMLButtonElement>("button[aria-label='Retained file versions']")!
        .click(),
    );
  }
  async function click(_fixture: _Fixture, label: string) {
    const button = [..._fixture.host.querySelectorAll("button")].find(
      (candidate) => candidate.textContent === label,
    )!;
    expect(button).toBeDefined();
    await act(async () => button.click());
  }
  async function copyPath(_fixture: _Fixture, path: string) {
    const input = _fixture.host.querySelector<HTMLInputElement>(
      "input[aria-label='Copy file path']",
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, path);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () =>
      _fixture.host
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
  }

  it("fetches retained evidence on each opening rather than remembering a previous session list", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await mount(_fixture);
    await click(_fixture, "Open read-only");
    expect(open).toHaveBeenCalledWith(version.retainedPath);
    commands.list.mockResolvedValue(
      AsyncResult.success({ versions: [], retainedBytes: 0, limitBytes: null, attention: null }),
    );
    await act(async () =>
      _fixture.host
        .querySelector<HTMLButtonElement>("button[aria-label='Retained file versions']")!
        .click(),
    );
    await act(async () =>
      _fixture.host
        .querySelector<HTMLButtonElement>("button[aria-label='Retained file versions']")!
        .click(),
    );
    expect(_fixture.host.querySelectorAll("li")).toHaveLength(0);
    expect(commands.discard).not.toHaveBeenCalled();
    expect(commands.write).not.toHaveBeenCalled();
  });

  it("requires confirmation before discarding and keeps failed discard available for review", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await mount(_fixture);
    await click(_fixture, "Discard…");
    expect(commands.discard).not.toHaveBeenCalled();
    await click(_fixture, "Cancel");
    expect(commands.discard).not.toHaveBeenCalled();
    await click(_fixture, "Discard…");
    commands.discard.mockResolvedValue(
      AsyncResult.failure(Cause.fail({ failure: "operation_failed" })),
    );
    await click(_fixture, "Discard retained version");
    expect(
      _fixture.host.querySelector("[aria-label='Confirm discard retained version']"),
    ).not.toBeNull();
    expect(_fixture.host.querySelectorAll("li")).toHaveLength(1);
    commands.discard.mockResolvedValue(AsyncResult.success({ versionId: version.versionId }));
    commands.list.mockResolvedValue(
      AsyncResult.success({ versions: [], retainedBytes: 0, limitBytes: null, attention: null }),
    );
    await click(_fixture, "Discard retained version");
    expect(
      _fixture.host.querySelector("[aria-label='Confirm discard retained version']"),
    ).toBeNull();
    expect(_fixture.host.querySelectorAll("li")).toHaveLength(0);
  });

  it("never overwrites a destination that appeared while the retained text was being read", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await mount(_fixture);
    await click(_fixture, "Save copy…");
    commands.write.mockImplementation(async (request: { input: { createOnly?: boolean } }) =>
      request.input.createOnly
        ? AsyncResult.failure(Cause.fail({ failure: "path_exists" }))
        : AsyncResult.success({ relativePath: "copy.md", revision: "overwritten" }),
    );
    await copyPath(_fixture, "copy.md");
    expect(open).not.toHaveBeenCalled();
    expect(_fixture.host.querySelector("input[aria-label='Copy file path']")).not.toBeNull();
    commands.write.mockResolvedValue(
      AsyncResult.success({ relativePath: "another.md", revision: "rCopy" }),
    );
    await copyPath(_fixture, "another.md");
    expect(open).toHaveBeenCalledWith("another.md");
    expect(_fixture.host.querySelector("input[aria-label='Copy file path']")).toBeNull();
  });

  it("refuses truncated and binary text copies without creating a damaged file", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await mount(_fixture);
    await click(_fixture, "Save copy…");
    commands.read.mockResolvedValueOnce(
      AsyncResult.success({ contents: "Only a prefix", revision: "rRead", truncated: true }),
    );
    await copyPath(_fixture, "copy.md");
    commands.read.mockResolvedValueOnce(
      AsyncResult.failure(Cause.fail({ failure: "binary_file" })),
    );
    await copyPath(_fixture, "copy.md");
    expect(commands.write).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(_fixture.host.querySelector("input[aria-label='Copy file path']")).not.toBeNull();
  });

  it("allows readonly connections to inspect retained bytes but never mutate history", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await mount(_fixture, false);
    await click(_fixture, "Open read-only");
    expect(open).toHaveBeenCalledWith(version.retainedPath);
    await click(_fixture, "Discard…");
    await click(_fixture, "Save copy…");
    expect(_fixture.host.querySelector("form")).toBeNull();
    expect(
      _fixture.host.querySelector("[aria-label='Confirm discard retained version']"),
    ).toBeNull();
    expect(commands.discard).not.toHaveBeenCalled();
    expect(commands.write).not.toHaveBeenCalled();
  });

  it("refuses a copy outside the workspace before reading or writing bytes", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await mount(_fixture);
    await click(_fixture, "Save copy…");
    await copyPath(_fixture, "../notes.md");
    expect(commands.read).not.toHaveBeenCalled();
    expect(commands.write).not.toHaveBeenCalled();
    expect(_fixture.host.querySelector("input[aria-label='Copy file path']")).not.toBeNull();
  });
  it("keeps retained attention visible until backend-confirmed acceptance and a fresh history read", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const attention = {
      recoveryId: "recovery-history",
      mutationId: "mutation-test",
      retainedPaths: [version.retainedPath],
      message: "Review this operation.",
    };
    commands.list.mockResolvedValue(AsyncResult.success({ ...history, attention }));
    const { promise: pending, resolve: accepted } = Promise.withResolvers<boolean>();
    const accept = vi.fn(() => pending);
    await mount(_fixture, true, accept);
    await click(_fixture, "Continue from this version");
    expect(accept).not.toHaveBeenCalled();
    await click(_fixture, "Show file on disk");
    expect(
      _fixture.host.querySelector("[aria-label='Reviewed current disk version'] pre")?.textContent,
    ).toBe("Retained text");
    await click(_fixture, "Continue from this version");
    expect(accept).toHaveBeenCalledWith(
      attention.recoveryId,
      readSnapshot("Retained text").revision,
    );
    expect(_fixture.host.querySelector("[role=alert]")).not.toBeNull();
    expect(commands.list).toHaveBeenCalledOnce();
    commands.list.mockResolvedValue(AsyncResult.success(history));
    await act(async () => accepted(true));
    expect(_fixture.host.querySelector("[role=alert]")).toBeNull();
    expect(_fixture.host.querySelectorAll("li")).toHaveLength(1);
  });

  it("does not accept retained attention while another surface holds pending input", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const attention = {
      recoveryId: "recovery-history",
      mutationId: "mutation-test",
      retainedPaths: [version.retainedPath],
      message: "Review this operation.",
    };
    commands.list.mockResolvedValue(AsyncResult.success({ ...history, attention }));
    const accept = vi.fn(async () => true);
    await mount(_fixture, true, accept, false);
    await click(_fixture, "Continue from this version");
    expect(accept).not.toHaveBeenCalled();
    expect(_fixture.host.querySelector("[role=alert]")).not.toBeNull();
  });
  it("keeps one copy intent and its original bytes over an ambiguous retry", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await mount(_fixture);
    await click(_fixture, "Save copy…");
    commands.write.mockResolvedValueOnce(
      AsyncResult.failure(Cause.fail({ failure: "operation_failed" })),
    );
    await copyPath(_fixture, "copy.md");
    const first = commands.write.mock.calls[0]![0].input;
    commands.read.mockResolvedValue(AsyncResult.success(readSnapshot("Late outside write")));
    await act(async () =>
      _fixture.host
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    const replay = commands.write.mock.calls[1]![0].input;
    expect(replay).toEqual(first);
    expect(replay.contents).toBe("Retained text");
    expect(open).toHaveBeenCalledWith("copy.md");
  });

  it("compares retained and current text read-only without publishing either version", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await mount(_fixture);
    commands.read
      .mockResolvedValueOnce(AsyncResult.success(readSnapshot("Current disk bytes")))
      .mockResolvedValueOnce(AsyncResult.success(readSnapshot("Retained late bytes")));
    await click(_fixture, "Compare with current…");
    const previews = [
      ..._fixture.host.querySelectorAll("[aria-label='Reviewed current disk version'] pre"),
    ].map((node) => node.textContent);
    expect(previews).toEqual(["Current disk bytes", "Retained late bytes"]);
    expect(commands.write).not.toHaveBeenCalled();
    expect(commands.discard).not.toHaveBeenCalled();
  });

  it("reviews physical absence without empty source, rejects appearance before and after resolution, then replays nullable acceptance", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const attention = {
      recoveryId: "missing-history",
      mutationId: "old",
      retainedPaths: [version.retainedPath],
      message: "Review.",
    };
    let absent = true;
    let unresolved = true;
    let appearAfterResolution = true;
    commands.list.mockImplementation(async () =>
      AsyncResult.success({ ...history, attention: unresolved ? attention : null }),
    );
    commands.read.mockImplementation(async () =>
      absent
        ? AsyncResult.failure(
            Cause.fail(
              new ProjectReadFileError({
                cwd: "/synthetic",
                relativePath: "notes.md",
                failure: "operation_failed",
                reason: "not_found",
                currentMissing: true,
                ...(unresolved
                  ? {
                      publicationOutcome: "retained-attention",
                      recoveryId: attention.recoveryId,
                      mutationId: attention.mutationId,
                      retainedPaths: attention.retainedPaths,
                    }
                  : {}),
              }),
            ),
          )
        : AsyncResult.success(readSnapshot("Outside bytes")),
    );
    commands.resolve.mockImplementation(async () => {
      unresolved = false;
      if (appearAfterResolution) {
        absent = false;
        appearAfterResolution = false;
      }
      return AsyncResult.success({ recoveryId: attention.recoveryId, revision: null });
    });
    await mount(_fixture);
    await click(_fixture, "Show file on disk");
    expect(
      _fixture.host.querySelector("[aria-label='Reviewed current disk version'] pre"),
    ).toBeNull();
    absent = false;
    await click(_fixture, "Continue from this version");
    expect(commands.resolve).not.toHaveBeenCalled();
    absent = true;
    await click(_fixture, "Show file on disk");
    await click(_fixture, "Continue from this version");
    expect(_fixture.host.querySelector("[role=alert]")).not.toBeNull();
    expect(commands.resolve).toHaveBeenCalledTimes(1);
    absent = true;
    await click(_fixture, "Continue from this version");
    expect(commands.resolve).toHaveBeenCalledTimes(2);
    expect(_fixture.host.querySelector("[role=alert]")).toBeNull();
    expect(commands.write).not.toHaveBeenCalled();
    expect(commands.discard).not.toHaveBeenCalled();
  });
});

function _createFixture() {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    host: undefined! as HTMLDivElement,
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
