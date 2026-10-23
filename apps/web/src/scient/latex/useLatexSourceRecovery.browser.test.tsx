import {
  render as _fixtureRender,
  type Screen,
  fakeTimers as _fixtureFakeTimers,
  act,
} from "../../../test/render";
import { useLayoutEffect } from "react";

import { describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId } from "@t3tools/contracts";
import {
  MarkdownPersistenceRegistry,
  keepBothVersions,
  type MarkdownPersistenceLease,
} from "~/scient/markdownEditor/persistence/markdownPersistenceRegistry";
import { createTestCheckpointStore } from "~/scient/markdownEditor/persistence/markdownDraftCheckpointTestkit";
import { useLatexSourceRecovery } from "./useLatexSourceRecovery";
import {
  checkpointVisualDraft,
  clearVisualDraft,
  flushVisualDraft,
  readPersistedVisualDraft,
} from "./visualDrafts";
import { parkUnpublishedSource, readStoredRecovery, removeRecovery } from "./visualRecovery";

const key = "synthetic-source-recovery";
const base = "\\documentclass{article}\n\\begin{document}Original.\\end{document}";
const mine = base.replace("Original", "Mine");
const newer = base.replace("Original", "Newer");

describe("Source recovery without a Visual editor", () => {
  let lease: MarkdownPersistenceLease;

  let disk: { source: string; revision: string };
  let presentation: string;
  const write = vi.fn();
  const openLease = () => {
    const registry = new MarkdownPersistenceRegistry({
      checkpointStore: createTestCheckpointStore(),
      debounceMs: 5_000,
      reconcile: () => keepBothVersions,
      createTransport: () => ({
        read: async () => disk,
        write: async (intent) => {
          await write(intent);
          if (intent.expectedRevision !== disk.revision) throw new Error("conflict");
          disk = { source: intent.source, revision: `${disk.revision}+` };
          return { revision: disk.revision };
        },
        classifyFailure: () => "conflict",
        subscribe: () => () => {},
        project: () => {},
      }),
    });
    return registry.acquire(
      {
        environmentId: EnvironmentId.make("recovery"),
        cwd: "/synthetic",
        relativePath: "paper.tex",
      },
      {
        contents: disk.source,
        revision: disk.revision,
        relativePath: "paper.tex",
        byteLength: disk.source.length,
        truncated: false,
      },
    )!;
  };
  function Host({ _fixture }: { _fixture: _Fixture }) {
    const current = useLatexSourceRecovery(lease, key, presentation);
    useLayoutEffect(() => {
      _fixture.publishRecovery(current);
    });
    return null;
  }
  async function _setupFixture0(_fixture: _Fixture) {
    _fixture.stack.use(_fixtureFakeTimers());

    localStorage.clear();
    clearVisualDraft(key);
    write.mockReset();
    disk = { source: base, revision: "r1" };
    presentation = "visual";
    lease = openLease();
    _fixture.container = document.createElement("div");
    document.body.append(_fixture.container);
    _fixture.root0 = _fixture.stack.use(
      await _fixtureRender(null, { container: _fixture.container, router: false }),
    );
  }
  const mount = async (_fixture: _Fixture) =>
    await act(async () => await _fixture.root0.rerender(<Host _fixture={_fixture} />));
  async function _cleanupFixture1(_fixture: _Fixture) {
    await act(async () => await _fixture.root0.unmount());
    lease.release();
    _fixture.container.remove();
    clearVisualDraft(key);
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
  it("checkpoints accepted Source typing, including pagehide before the coalesced write", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await mount(_fixture);
    await act(async () => {
      lease.change(mine, lease.getSnapshot().editVersion);
    });
    window.dispatchEvent(new Event("pagehide"));
    expect(readPersistedVisualDraft(key)).toEqual({ source: mine, baseRevision: "r1" });
    expect(write).not.toHaveBeenCalled();
  });
  it("offers a reopened source copy without writing, then applies only the compared version", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    checkpointVisualDraft(key, mine, "r1");
    flushVisualDraft(key);
    await mount(_fixture);
    expect(_fixture.recovery.recovery?.source).toBe(mine);
    expect(lease.getSnapshot().draftSource).toBe(base);
    expect(write).not.toHaveBeenCalled();
    await act(async () => {
      lease.change(newer, lease.getSnapshot().editVersion);
    });
    await act(async () => {
      expect(_fixture.recovery.apply(base)).toBe(false);
    });
    await act(async () => {
      expect(_fixture.recovery.apply(newer)).toBe(true);
    });
    expect(lease.getSnapshot().draftSource).toBe(mine);
    expect(_fixture.recovery.recovery).toBeNull();
    expect(readPersistedVisualDraft(key)?.source).toBe(mine);
    await act(async () => {
      expect(await lease.flushNow()).toBe(true);
    });
    expect(readPersistedVisualDraft(key)).toBeNull();
  });
  it("keeps offered work while new Source edits are saved", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    parkUnpublishedSource(key, mine, "r0");
    await mount(_fixture);
    await act(async () => {
      lease.change(newer, lease.getSnapshot().editVersion);
    });
    await act(async () => {
      await lease.flushNow();
    });
    expect(_fixture.recovery.recovery?.source).toBe(mine);
    expect(readStoredRecovery(key)?.source).toBe(mine);
    expect(disk.source).toBe(newer);
  });
  it("discards only the shown record when another independent recovery arrived", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    parkUnpublishedSource(key, mine, "r0");
    await mount(_fixture);
    parkUnpublishedSource(key, newer, "r2");
    await act(async () => _fixture.recovery.discard());
    expect(_fixture.recovery.recovery?.source).toBe(newer);
    expect(readStoredRecovery(key)?.source).toBe(newer);
  });
  it("refreshes resolved Visual offers when returning to Source without parking current typing", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    parkUnpublishedSource(key, mine, "r0");
    await mount(_fixture);
    removeRecovery(key, _fixture.recovery.recovery!);
    await act(async () => {
      lease.change(newer, lease.getSnapshot().editVersion);
    });
    flushVisualDraft(key);
    presentation = "source";
    await mount(_fixture);
    expect(_fixture.recovery.recovery).toBeNull();
    expect(readPersistedVisualDraft(key)?.source).toBe(newer);
  });
  it("keeps later typing recoverable across an earlier save acknowledgement", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    const first = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const second = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    write.mockImplementation((intent) => (intent.source === mine ? first : second));
    await mount(_fixture);
    let firstLanded!: () => void;
    const acknowledged = new Promise<void>((resolve) => {
      firstLanded = resolve;
    });
    const stop = lease.subscribe(() => {
      if (lease.getSnapshot().baselineSource === mine) firstLanded();
    });
    let saved!: Promise<boolean>;
    await act(async () => {
      lease.change(mine, lease.getSnapshot().editVersion);
      saved = lease.flushNow();
    });
    expect(write).toHaveBeenCalledOnce();
    await act(async () => {
      lease.change(newer, lease.getSnapshot().editVersion);
    });
    flushVisualDraft(key);
    expect(readPersistedVisualDraft(key)).toEqual({ source: newer, baseRevision: "r1" });
    await act(async () => {
      releaseFirst();
      await acknowledged;
    });
    expect(disk.source).toBe(mine);
    expect(lease.getSnapshot()).toMatchObject({ draftSource: newer, pending: true });
    expect(readPersistedVisualDraft(key)).toEqual({ source: newer, baseRevision: "r1" });
    await act(async () => {
      releaseSecond();
      expect(await saved).toBe(true);
    });
    expect(disk.source).toBe(newer);
    expect(readPersistedVisualDraft(key)).toBeNull();
    stop();
  });
  it("retains a newer checkpoint when an earlier save finishes", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await mount(_fixture);
    await act(async () => {
      lease.change(mine, lease.getSnapshot().editVersion);
    });
    checkpointVisualDraft(key, newer, "r1");
    flushVisualDraft(key);
    await act(async () => {
      await lease.flushNow();
    });
    expect(readPersistedVisualDraft(key)?.source).toBe(newer);
  });
});

function _createFixture() {
  let _published_recovery = undefined! as ReturnType<typeof useLatexSourceRecovery>;

  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    get recovery() {
      return _published_recovery;
    },
    publishRecovery(next: typeof _published_recovery) {
      _published_recovery = next;
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
