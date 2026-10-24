import { act, render, fakeTimers } from "../../../test/render";
import { EnvironmentId } from "@t3tools/contracts";
import { projectFileOperationKey } from "@t3tools/client-runtime/state/projects";
import { AsyncResult } from "effect/reactivity";
import * as Cause from "effect/Cause";
import { StrictMode, useLayoutEffect } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

interface Request {
  input: { contents: string; expectedRevision?: string; mutationId: string; createOnly?: boolean };
}
const runtime = vi.hoisted(() => ({
  canWrite: true,
  projectedSource: "A",
  pending: false,
  kind: "transient" as "transient" | "target_changed",
  write: null as null | ((request: Request) => Promise<unknown>),
  read: null as null | (() => Promise<unknown>),
  resolve: null as
    | null
    | ((review: { recoveryId: string; currentRevision: string | null }) => Promise<unknown>),
}));
// Browser modules link by name, so each mock keeps the module's other exports.
vi.mock(import("~/state/session"), async (original) => ({
  ...(await original()),
  readEnvironmentScope: (() => runtime.canWrite) as never,
}));
vi.mock(import("~/state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => write) as never,
}));
const write = (request: Request) => runtime.write!(request);
vi.mock(
  import("~/scient/markdownEditor/persistence/markdownPersistenceTransport"),
  async (original) => ({
    ...(await original()),
    classifyMarkdownPersistenceFailure: (() => runtime.kind) as never,
    createMarkdownPersistenceTransport: (() => ({
      read: () => runtime.read!(),
      readForReview: () => runtime.read!(),
      resolve: (review: { recoveryId: string; currentRevision: string | null }) =>
        runtime.resolve!(review),
    })) as never,
  }),
);
vi.mock(import("~/scient/markdownEditor/persistence/documentFailureReason"), async (original) => ({
  ...(await original()),
  describeDocumentPublicationAttention: (() => null) as never,
  documentPublicationOutcome: (() =>
    runtime.kind === "target_changed" ? "unchanged" : null) as never,
}));
vi.mock(import("~/rpc/atomRegistry"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    appAtomRegistry: Object.assign(Object.create(actual.appAtomRegistry), {
      refresh: () => {},
    }) as typeof actual.appAtomRegistry,
  };
});
vi.mock(import("./projectFilesQueryState"), async (original) => ({
  ...(await original()),
  setProjectFileQueryData: ((
    _environment: unknown,
    _cwd: string,
    _path: string,
    source: string,
  ) => {
    runtime.projectedSource = source;
  }) as never,
  confirmProjectFileQueryData: ((
    _environment: unknown,
    _cwd: string,
    _path: string,
    source: string,
  ) => runtime.projectedSource === source) as never,
  getProjectFileQueryAtom: (() => "query") as never,
}));

import { indexedDbMarkdownDrafts } from "~/scient/markdownEditor/persistence/markdownDraftCheckpoint";
import {
  clearWorkspaceFileSessionsForTests,
  useFileSaveCoordinator,
  type FileSaveOptions,
  type FileSaveSessionActions,
} from "./useFileSaveCoordinator";
// SCIENT-FORK:START — the server's editor flush reaches a mounted editor by its file.
import { flushWorkspaceFileSessionsWhere } from "./useFileSaveCoordinator";
// SCIENT-FORK:END
const environmentId = EnvironmentId.make("generic-save-hook");
const props: FileSaveOptions = {
  environmentId,
  cwd: "/repo",
  relativePath: "file.txt",
  initialSource: "A",
  revision: "rA",
  onPendingChange: (_path, pending) => {
    runtime.pending = pending;
  },
  onSaveFailure: () => {},
  onSaveConfirmed: () => {},
  onSaveResolutionApplied: () => {},
  saveResolution: null,
};
const key = projectFileOperationKey(props);
async function setup() {
  const timers = fakeTimers();
  runtime.canWrite = true;
  runtime.projectedSource = "A";
  runtime.pending = false;
  runtime.kind = "transient";
  runtime.read = async () => ({ revision: "rA" });
  runtime.resolve = async (review) => ({ revision: review.currentRevision });
  const sessionKeys = new Set([key]);
  let screen: Awaited<ReturnType<typeof render>> | null = null;
  let latestActions: FileSaveSessionActions | null = null;
  function Surface(input: FileSaveOptions) {
    const coordinator = useFileSaveCoordinator(input);
    useLayoutEffect(() => {
      latestActions = coordinator;
    });
    return null;
  }
  const ui = (input: FileSaveOptions) => (
    <StrictMode>
      <Surface {...input} />
    </StrictMode>
  );
  const actions = () => latestActions!;
  async function mount(input = props) {
    sessionKeys.add(projectFileOperationKey(input));
    screen = await render(ui(input), { router: false });
    await act(async () => {
      expect(await actions().ready()).toBe(true);
    });
  }
  async function reconstruct(input = props) {
    await screen?.[Symbol.asyncDispose]();
    screen = null;
    latestActions = null;
    clearWorkspaceFileSessionsForTests();
    await mount(input);
  }
  return {
    actions,
    mount,
    reconstruct,
    rerender: (input: FileSaveOptions) => {
      sessionKeys.add(projectFileOperationKey(input));
      return screen!.rerender(ui(input));
    },
    unmount: async () => {
      await screen?.[Symbol.asyncDispose]();
      screen = null;
    },
    async [Symbol.asyncDispose]() {
      try {
        await screen?.[Symbol.asyncDispose]();
        clearWorkspaceFileSessionsForTests();
        for (const sessionKey of sessionKeys) {
          const copy = await indexedDbMarkdownDrafts.read(sessionKey);
          if (copy) await indexedDbMarkdownDrafts.replace(sessionKey, copy.token, undefined);
        }
      } finally {
        timers[Symbol.dispose]();
      }
    },
  };
}

describe("actual generic consumer durable ownership", () => {
  it("restores C from IndexedDB instead of a stale optimistic cache and replays frozen B with its lost-ACK ID before refusing outside D", async () => {
    await using fixture = await setup();
    const { actions, mount, reconstruct } = fixture;
    let disk = { source: "A", revision: "rA" };
    let lost = true;
    const receipts = new Map<
      string,
      { source: string; expected: string | undefined; revision: string }
    >();
    runtime.write = async ({ input }) => {
      const durable = await indexedDbMarkdownDrafts.read(key);
      expect(durable?.publicationIntent).toMatchObject({
        source: input.contents,
        mutationId: input.mutationId,
        expectedRevision: input.expectedRevision,
      });
      const receipt = receipts.get(input.mutationId);
      if (receipt) {
        if (receipt.source !== input.contents || receipt.expected !== input.expectedRevision)
          throw new Error("Identity changed on reconstruction");
        return AsyncResult.success({ revision: receipt.revision });
      }
      if (disk.revision !== input.expectedRevision) {
        runtime.kind = "target_changed";
        return AsyncResult.failure(Cause.fail(new Error("Outside revision")));
      }
      disk = { source: input.contents, revision: `r${input.contents}` };
      receipts.set(input.mutationId, {
        source: input.contents,
        expected: input.expectedRevision,
        revision: disk.revision,
      });
      if (lost) {
        lost = false;
        throw new Error("Lost acknowledgement");
      }
      return AsyncResult.success({ revision: disk.revision });
    };
    await mount();
    await act(async () => {
      runtime.projectedSource = "B";
      actions().change("B");
      expect(await actions().flush()).toBe(false);
      runtime.projectedSource = "C";
      actions().change("C");
      await actions().ready();
    });
    const originalId = (await indexedDbMarkdownDrafts.read(key))!.publicationIntent!.mutationId;
    disk = { source: "D", revision: "rD" };
    runtime.projectedSource = "stale optimistic cache";
    await reconstruct({ ...props, initialSource: "D", revision: "rD" });
    expect(runtime.projectedSource).toBe("C");
    await act(async () => {
      expect(await actions().flush()).toBe(false);
    });
    expect(disk).toEqual({ source: "D", revision: "rD" });
    expect(receipts.get(originalId)).toEqual({ source: "B", expected: "rA", revision: "rB" });
    expect(actions().reviewRequired).toBe(true);
    expect(runtime.pending).toBe(true);
  });

  it("keeps accepted missing current through complete renderer reconstruction and later typing; only explicit recreation reaches the RPC", async () => {
    await using fixture = await setup();
    const { actions, mount, reconstruct } = fixture;
    const attention = {
      recoveryId: "missing",
      mutationId: "prior",
      retainedPaths: ["draft.copy"],
      message: "Retained publication",
    };
    let retained = true;
    let disk: { source: string; revision: string } | null = null;
    runtime.read = async () => ({
      missing: true,
      revision: null,
      publicationAttention: retained ? attention : null,
    });
    runtime.resolve = async () => {
      retained = false;
      return { revision: null };
    };
    runtime.write = async ({ input }) => {
      if (!input.createOnly || disk !== null)
        return AsyncResult.failure(Cause.fail(new Error("Not an exclusive create")));
      disk = { source: input.contents, revision: `r${input.contents}` };
      return AsyncResult.success({ revision: disk.revision });
    };
    await mount({ ...props, publicationAttention: attention });
    await act(async () => {
      actions().change("B");
      expect(await actions().resolveRetainedAttention("missing", null)).toBe(true);
    });
    await reconstruct({ ...props, initialSource: "", revision: "" });
    expect(actions().currentMissing).toBe(true);
    await act(async () => {
      actions().change("C");
      await vi.advanceTimersByTimeAsync(5_000);
      expect(await actions().flush()).toBe(false);
    });
    expect(disk).toBeNull();
    expect(runtime.pending).toBe(true);
    await act(async () => {
      runtime.projectedSource = "C";
      expect(actions().recreateMissingCurrent("stale rendered source")).toBe(true);
      expect(await actions().flush()).toBe(true);
    });
    expect(disk).toEqual({ source: "C", revision: "rC" });
    expect(actions().currentMissing).toBe(false);
    expect(runtime.pending).toBe(false);
  });

  it("ignores retired React callbacks and preserves denied input until permission returns", async () => {
    await using fixture = await setup();
    const { actions, mount, reconstruct } = fixture;
    let disk = "A";
    runtime.write = async ({ input }) => {
      disk = input.contents;
      return AsyncResult.success({ revision: `r${input.contents}` });
    };
    await mount();
    const retiredChange = actions().change;
    await act(async () => {
      runtime.canWrite = false;
      runtime.projectedSource = "B";
      retiredChange("B");
      expect(await actions().flush()).toBe(false);
    });
    await reconstruct();
    retiredChange("stale callback");
    expect(runtime.projectedSource).toBe("B");
    expect(disk).toBe("A");
    await act(async () => {
      runtime.canWrite = true;
      expect(await actions().flush()).toBe(true);
    });
    expect(disk).toBe("B");
    expect(runtime.pending).toBe(false);
  });
});

it.each([
  { relativePath: "other.txt" },
  { cwd: "/other-workspace" },
  { environmentId: EnvironmentId.make("other-environment") },
])("retires editor callbacks when the file identity changes: %j", async (change) => {
  await using fixture = await setup();
  const { actions, mount, rerender } = fixture;
  const writes: string[] = [];
  runtime.write = async ({ input }) => {
    writes.push(input.contents);
    return AsyncResult.success({ revision: `r${input.contents}` });
  };
  await mount();
  const retired = actions().change;
  await act(async () => {
    runtime.projectedSource = "old file edit";
    retired("old file edit");
    expect(await actions().flush()).toBe(true);
  });
  await rerender({ ...props, ...change });
  await act(async () => {
    expect(await actions().ready()).toBe(true);
    retired("stale editor contents");
    runtime.projectedSource = "new file edit";
    actions().change("new file edit");
    expect(await actions().flush()).toBe(true);
  });
  expect(writes).toEqual(["old file edit", "new file edit"]);
});

it.each([false, true])(
  "retains input when permission is revoked before React updates, unmount=%s",
  async (unmount) => {
    await using fixture = await setup();
    const { actions, mount } = fixture;
    const write = vi.fn(async () => AsyncResult.success({ revision: "rB" }));
    runtime.write = write;
    await mount();
    await act(async () => {
      runtime.projectedSource = "B";
      actions().change("B");
      runtime.canWrite = false;
      expect(await actions().flush()).toBe(false);
    });
    if (unmount) await fixture.unmount();
    await vi.advanceTimersByTimeAsync(500);
    expect(write).not.toHaveBeenCalled();
    expect(runtime.pending).toBe(true);
    expect(await indexedDbMarkdownDrafts.read(key)).toMatchObject({ draftSource: "B" });
    runtime.canWrite = true;
    if (unmount) {
      runtime.projectedSource = "A";
      await fixture.reconstruct();
      expect(runtime.projectedSource).toBe("B");
    }
    await act(async () => {
      expect(await actions().flush()).toBe(true);
    });
    expect(write).toHaveBeenCalledOnce();
    expect(runtime.pending).toBe(false);
  },
);

it("flushes on unmount and ignores the released editor callback", async () => {
  await using fixture = await setup();
  const completed = Promise.withResolvers<void>();
  const writes = vi.fn(async (_request: Request) => AsyncResult.success({ revision: "rB" }));
  runtime.write = writes;
  await fixture.mount({
    ...props,
    onPendingChange: (_path, pending) => {
      runtime.pending = pending;
      if (!pending) completed.resolve();
    },
  });
  const retired = fixture.actions().change;
  await act(async () => {
    runtime.projectedSource = "B";
    retired("B");
  });
  await fixture.unmount();
  retired("stale editor contents");
  await completed.promise;
  await fixture.mount({ ...props, initialSource: "B", revision: "rB" });
  await act(async () => expect(await fixture.actions().flush()).toBe(true));
  expect(writes).toHaveBeenCalledOnce();
  expect(writes.mock.calls[0]?.[0].input.contents).toBe("B");
});

// SCIENT-FORK:START — the server's editor flush reaches a mounted editor by its file.
describe("folder flush of a mounted editor", () => {
  it("saves the editor's text when its file is picked, and leaves it when not", async () => {
    await using fixture = await setup();
    const writes: string[] = [];
    runtime.write = async ({ input }) => {
      writes.push(input.contents);
      return AsyncResult.success({ revision: `r${input.contents}` });
    };
    await fixture.mount();
    await act(async () => {
      runtime.projectedSource = "B";
      fixture.actions().change("B");
      expect(
        await flushWorkspaceFileSessionsWhere((target) => target.relativePath === "other.txt"),
      ).toEqual([]);
    });
    expect(writes).toEqual([]);
    await act(async () => {
      expect(
        await flushWorkspaceFileSessionsWhere(
          (target) =>
            target.environmentId === environmentId &&
            target.cwd === "/repo" &&
            target.relativePath === "file.txt",
        ),
      ).toEqual([
        { target: { environmentId, cwd: "/repo", relativePath: "file.txt" }, saved: true },
      ]);
    });
    expect(writes).toEqual(["B"]);
  });
});
// SCIENT-FORK:END
