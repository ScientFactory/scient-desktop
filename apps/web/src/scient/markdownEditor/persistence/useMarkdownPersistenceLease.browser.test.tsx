import {
  render as _fixtureRender,
  type Screen,
  fakeTimers as _fixtureFakeTimers,
  act,
} from "../../../../test/render";
import { createTestCheckpointStore } from "./markdownDraftCheckpointTestkit";
import type * as MarkdownCheckpointModule from "./markdownDraftCheckpoint";
import {
  EnvironmentId,
  ProjectReadFileError,
  type ProjectReadFileResult,
} from "@t3tools/contracts";
import { StrictMode, useLayoutEffect } from "react";

import { describe, expect, it, vi } from "vite-plus/test";
import type { MarkdownPersistenceTransport } from "./markdownPersistenceTransport";

vi.mock("./markdownDraftCheckpoint", async (importOriginal) => ({
  ...(await importOriginal<typeof MarkdownCheckpointModule>()),
  indexedDbMarkdownDrafts: createTestCheckpointStore(),
}));

const mocks = vi.hoisted(() => ({ createTransport: vi.fn() }));
vi.mock("./markdownPersistenceTransport", () => ({
  createMarkdownPersistenceTransport: mocks.createTransport,
}));

import type { MarkdownPersistenceLease } from "./markdownPersistenceRegistry";
import { useMarkdownPersistenceLease } from "./useMarkdownPersistenceLease";

describe("useMarkdownPersistenceLease", () => {
  const environmentId = EnvironmentId.make("hook-synthetic-environment");

  let transport: MarkdownPersistenceTransport;
  let pathIndex = 0;
  const cwd = "/synthetic-workspace";
  let initial: ProjectReadFileResult;

  async function _setupFixture0(_fixture: _Fixture) {
    _fixture.stack.use(_fixtureFakeTimers());
    _fixture.container = document.createElement("div");
    document.body.append(_fixture.container);
    _fixture.root0 = _fixture.stack.use(
      await _fixtureRender(null, { container: _fixture.container, router: false }),
    );
    pathIndex += 1;
    initial = {
      contents: "A",
      revision: "rA",
      byteLength: 1,
      truncated: false,
      relativePath: `hook-${pathIndex}.md`,
    };
    transport = {
      write: vi.fn(async (intent) => ({ revision: `r${intent.source}` })),
      read: vi.fn(async () => ({ source: "A", revision: "rA" })),
      classifyFailure: () => "terminal",
      subscribe: vi.fn(() => vi.fn()),
      project: vi.fn(),
    };
    mocks.createTransport.mockReset().mockReturnValue(transport);
  }
  async function _cleanupFixture1(_fixture: _Fixture) {
    await act(async () => await _fixture.root0.unmount());
    _fixture.container.remove();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }

  function Surface({
    _fixture,
    ...props
  }: {
    snapshot?: ProjectReadFileResult | null;
    path?: string;
    readError?: ProjectReadFileError;
    onAttentionResolved?: () => void;
  } & { _fixture: _Fixture }) {
    const current = useMarkdownPersistenceLease({
      target: { environmentId, cwd, relativePath: props.path ?? initial.relativePath },
      authoritativeSnapshot: props.snapshot === undefined ? initial : props.snapshot,
      ...(props.readError ? { authoritativeReadError: props.readError } : {}),
      ...(props.onAttentionResolved ? { onAttentionResolved: props.onAttentionResolved } : {}),
    });
    useLayoutEffect(() => {
      _fixture.publishLatest(current);
    }, [_fixture, current]);
    return <span>{current.snapshot?.draftSource ?? "loading"}</span>;
  }

  it("uses a qualified missing cache hint only for admission, then adopts the real ordered current source", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const context = { cwd, relativePath: initial.relativePath };
    const readForReview = vi.fn(async () => ({
      source: "foreign current",
      revision: "foreign-current",
    }));
    transport = { ...transport, readForReview };
    mocks.createTransport.mockReturnValue(transport);
    await act(
      async () =>
        await _fixture.root0.rerender(
          <Surface
            _fixture={_fixture}
            snapshot={null}
            readError={
              new ProjectReadFileError({
                ...context,
                failure: "operation_failed",
                reason: "not_found",
              })
            }
          />,
        ),
    );
    expect(_fixture.latest.lease).toBeNull();
    expect(readForReview).not.toHaveBeenCalled();

    await act(
      async () =>
        await _fixture.root0.rerender(
          <Surface
            _fixture={_fixture}
            snapshot={null}
            readError={
              new ProjectReadFileError({
                ...context,
                failure: "operation_failed",
                reason: "not_found",
                currentMissing: true,
              })
            }
          />,
        ),
    );
    expect(_fixture.latest.snapshot).toMatchObject({
      baselineSource: "foreign current",
      baselineRevision: "foreign-current",
      draftSource: "foreign current",
      currentMissing: false,
      pending: false,
    });
    expect(transport.write).not.toHaveBeenCalled();
  });

  it("survives StrictMode effect replay and re-rendered cache snapshots with one coordinator", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await act(
      async () =>
        await _fixture.root0.rerender(
          <StrictMode>
            <Surface _fixture={_fixture} />
          </StrictMode>,
        ),
    );
    const lease = _fixture.latest.lease!;
    await act(async () => {
      expect(lease.change("B", 0)).toBe(true);
    });
    await act(
      async () =>
        await _fixture.root0.rerender(
          <StrictMode>
            <Surface
              _fixture={_fixture}
              snapshot={{ ...initial, contents: "stale", revision: "stale" }}
            />
          </StrictMode>,
        ),
    );
    expect(_fixture.latest.lease).toBe(lease);
    expect(_fixture.container.textContent).toBe("B");
    expect(mocks.createTransport).toHaveBeenCalledTimes(1);
    await act(async () => {
      await lease.flushNow();
    });
    expect(transport.write).toHaveBeenCalledTimes(1);
  });

  it("keeps an existing draft when later cached data is unavailable or truncated", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await act(async () => await _fixture.root0.rerender(<Surface _fixture={_fixture} />));
    const lease = _fixture.latest.lease!;
    await act(async () => {
      lease.change("B", 0);
    });
    await act(
      async () => await _fixture.root0.rerender(<Surface _fixture={_fixture} snapshot={null} />),
    );
    expect(_fixture.latest.lease).toBe(lease);
    await act(
      async () =>
        await _fixture.root0.rerender(
          <Surface _fixture={_fixture} snapshot={{ ...initial, truncated: true }} />,
        ),
    );
    expect(_fixture.latest.lease).toBe(lease);
    expect(_fixture.container.textContent).toBe("B");
  });

  it("releases surface recovery notices only after the owned explicit acceptance confirms, preserving local input", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const publicationAttention = {
      recoveryId: "hook-retained",
      mutationId: "hook-mutation",
      retainedPaths: ["/retained/previous.md"],
      message: "A displaced object needs review.",
    };
    let accepted = false;
    let loseConfirmation = true;
    vi.mocked(transport.read).mockImplementation(async () => {
      if (accepted && loseConfirmation) {
        loseConfirmation = false;
        throw new Error("Confirmation reply lost");
      }
      return { source: "A", revision: "rA", ...(accepted ? {} : { publicationAttention }) };
    });
    transport = {
      ...transport,
      resolve: vi.fn(async () => {
        accepted = true;
        return { recoveryId: publicationAttention.recoveryId, revision: "rA" };
      }),
    };
    mocks.createTransport.mockReturnValue(transport);
    const onAttentionResolved = vi.fn();
    await act(
      async () =>
        await _fixture.root0.rerender(
          <Surface _fixture={_fixture} onAttentionResolved={onAttentionResolved} />,
        ),
    );
    expect(_fixture.latest.snapshot?.publicationAttention).toEqual(publicationAttention);
    const lease = _fixture.latest.lease!;
    await act(async () => {
      lease.change("Local input", lease.getSnapshot().editVersion);
      expect(await lease.resolveRetainedAttention(publicationAttention.recoveryId, "rA")).toBe(
        false,
      );
    });
    expect(onAttentionResolved).not.toHaveBeenCalled();
    expect(_fixture.latest.snapshot).toMatchObject({
      attention: "recovery_required",
      draftSource: "Local input",
    });
    await act(
      async () =>
        await _fixture.root0.rerender(
          <Surface
            _fixture={_fixture}
            snapshot={initial}
            onAttentionResolved={onAttentionResolved}
          />,
        ),
    );
    expect(onAttentionResolved).not.toHaveBeenCalled();
    await act(async () => {
      expect(await lease.resolveRetainedAttention(publicationAttention.recoveryId, "rA")).toBe(
        true,
      );
    });
    expect(onAttentionResolved).toHaveBeenCalledOnce();
    expect(_fixture.latest.snapshot).toMatchObject({
      attention: null,
      draftSource: "Local input",
      baselineSource: "A",
      conflict: { externalSource: "A", externalRevision: "rA" },
      pending: true,
    });
    expect(transport.write).not.toHaveBeenCalled();
    await act(
      async () =>
        await _fixture.root0.rerender(
          <Surface
            _fixture={_fixture}
            path={`clean-${initial.relativePath}`}
            snapshot={initial}
            onAttentionResolved={onAttentionResolved}
          />,
        ),
    );
    expect(onAttentionResolved).toHaveBeenCalledOnce();
  });

  it("revokes old callbacks on a path switch and never displays the old binding for the new path", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await act(async () => await _fixture.root0.rerender(<Surface _fixture={_fixture} />));
    const previous = _fixture.latest.lease!;
    vi.mocked(transport.read).mockResolvedValue({ source: "other", revision: "rother" });
    await act(
      async () =>
        await _fixture.root0.rerender(
          <Surface
            _fixture={_fixture}
            path="other-hook.md"
            snapshot={{
              ...initial,
              relativePath: "other-hook.md",
              contents: "other",
              revision: "rother",
            }}
          />,
        ),
    );
    expect(_fixture.container.textContent).toBe("other");
    expect(previous.change("late", 0)).toBe(false);
    expect(_fixture.latest.lease?.target.relativePath).toBe("other-hook.md");
  });

  it("follows its document through an in-place rename with the same lease, never without one", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const seen: Array<MarkdownPersistenceLease | null> = [];
    function Tracking(props: { path: string }) {
      const current = useMarkdownPersistenceLease({
        target: { environmentId, cwd, relativePath: props.path },
        authoritativeSnapshot: props.path === initial.relativePath ? initial : null,
      });
      seen.push(current.lease);
      useLayoutEffect(() => {
        _fixture.publishLatest(current);
      }, [current]);
      return <span>{current.snapshot?.draftSource ?? "loading"}</span>;
    }
    const before = initial.relativePath;
    const after = `moved-${before}`;
    await act(
      async () =>
        await _fixture.root0.rerender(
          <StrictMode>
            <Tracking path={before} />
          </StrictMode>,
        ),
    );
    const lease = _fixture.latest.lease!;
    seen.length = 0;
    await act(async () => {
      const move = lease.beginMove({ environmentId, cwd, relativePath: after })!;
      expect(move).not.toBeNull();
      expect(await move.preflight()).toBe("empty");
      const intent = await move.admitRename();
      expect(
        await move.acknowledgeRename({
          destinationRelativePath: after,
          revision: intent.expectedRevision,
        }),
      ).toBe(true);
      expect(await move.commit()).toBe(true);
      move.finish();
      await _fixture.root0.rerender(
        <StrictMode>
          <Tracking path={after} />
        </StrictMode>,
      );
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(seen.every((each) => each === lease)).toBe(true);
    expect(_fixture.latest.lease).toBe(lease);
    expect(lease.target.relativePath).toBe(after);
    // Still the live owner of the document: edits are accepted.
    await act(async () => {
      expect(lease.change("moved edit", lease.getSnapshot().editVersion)).toBe(true);
    });
    expect(_fixture.container.textContent).toBe("moved edit");
  });

  it("releases a moved lease when the view goes away before following it", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await act(async () => await _fixture.root0.rerender(<Surface _fixture={_fixture} />));
    const lease = _fixture.latest.lease!;
    await act(async () => {
      const move = lease.beginMove({
        environmentId,
        cwd,
        relativePath: `gone-${initial.relativePath}`,
      })!;
      expect(await move.preflight()).toBe("empty");
      const intent = await move.admitRename();
      expect(
        await move.acknowledgeRename({
          destinationRelativePath: `gone-${initial.relativePath}`,
          revision: intent.expectedRevision,
        }),
      ).toBe(true);
      expect(await move.commit()).toBe(true);
      move.finish();
    });
    await act(async () => await _fixture.root0.rerender(<span />));
    // Released: the lease no longer acts for the document.
    expect(lease.change("late", lease.getSnapshot().editVersion)).toBe(false);
  });

  it("exposes a failed ordered admission without enabling an editor and retries explicitly", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const failure = new Error("Unavailable");
    vi.mocked(transport.read).mockRejectedValueOnce(failure);
    await act(async () => await _fixture.root0.rerender(<Surface _fixture={_fixture} />));
    expect(_fixture.latest.lease).toBeNull();
    expect(_fixture.latest.admissionError).toBe(failure);
    expect(_fixture.container.textContent).toBe("loading");
    await act(async () => _fixture.latest.retryAdmission());
    expect(_fixture.latest.admissionError).toBeNull();
    expect(_fixture.latest.lease).not.toBeNull();
    expect(_fixture.container.textContent).toBe("A");
  });

  it("does not attach a late bootstrap result to a different path", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    let finishFirst!: (snapshot: { source: string; revision: string }) => void;
    const pending = new Promise<{ source: string; revision: string }>((resolve) => {
      finishFirst = resolve;
    });
    vi.mocked(transport.read)
      .mockReturnValueOnce(pending)
      .mockResolvedValueOnce({ source: "second", revision: "second" });
    await act(async () => await _fixture.root0.rerender(<Surface _fixture={_fixture} />));
    expect(_fixture.latest.lease).toBeNull();
    await act(
      async () =>
        await _fixture.root0.rerender(
          <Surface _fixture={_fixture} path="late-bootstrap-target.md" />,
        ),
    );
    const second = _fixture.latest.lease;
    expect(_fixture.container.textContent).toBe("second");
    await act(async () => finishFirst({ source: "late first", revision: "late-first" }));
    expect(_fixture.latest.lease).toBe(second);
    expect(_fixture.container.textContent).toBe("second");
  });
});

function _createFixture() {
  let _published_latest = undefined! as ReturnType<typeof useMarkdownPersistenceLease>;

  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    get latest() {
      return _published_latest;
    },
    publishLatest(next: typeof _published_latest) {
      _published_latest = next;
    },

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
