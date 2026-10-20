import "fake-indexeddb/auto";
import { EnvironmentId } from "@t3tools/contracts";
import { projectFileOperationKey } from "@t3tools/client-runtime/state/projects";
import { AsyncResult } from "effect/reactivity";
import * as Cause from "effect/Cause";
import { act, StrictMode, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

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
let root: Root | null = null;
// The actions of the latest commit, as the surface would hold them.
let latestActions: FileSaveSessionActions | null = null;
function Surface(input: FileSaveOptions) {
  const coordinator = useFileSaveCoordinator(input);
  useLayoutEffect(() => {
    latestActions = coordinator;
  });
  return null;
}
function actions(): FileSaveSessionActions {
  return latestActions!;
}
async function mount(input = props) {
  await act(async () => {
    root = createRoot(document.createElement("div"));
    root.render(
      <StrictMode>
        <Surface {...input} />
      </StrictMode>,
    );
  });
  await act(async () => {
    expect(await actions().ready()).toBe(true);
  });
}
async function reconstruct(input = props) {
  await act(async () => {
    root!.unmount();
    root = null;
    latestActions = null;
    clearWorkspaceFileSessionsForTests();
  });
  await mount(input);
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  runtime.canWrite = true;
  runtime.projectedSource = "A";
  runtime.pending = false;
  runtime.kind = "transient";
  runtime.read = async () => ({ revision: "rA" });
  runtime.resolve = async (review) => ({ revision: review.currentRevision });
});
afterEach(async () => {
  await act(async () => {
    root?.unmount();
    root = null;
    latestActions = null;
    clearWorkspaceFileSessionsForTests();
  });
  const copy = await indexedDbMarkdownDrafts.read(key);
  if (copy) await indexedDbMarkdownDrafts.replace(key, copy.token, undefined);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("actual generic consumer durable ownership", () => {
  it("restores C from IndexedDB instead of a stale optimistic cache and replays frozen B with its lost-ACK ID before refusing outside D", async () => {
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
