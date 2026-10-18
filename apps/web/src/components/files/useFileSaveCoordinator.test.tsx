import "fake-indexeddb/auto";
import { EnvironmentId } from "@t3tools/contracts";
import { projectFileOperationKey } from "@t3tools/client-runtime/state/projects";
import { AsyncResult } from "effect/reactivity";
import * as Cause from "effect/Cause";
import { act, StrictMode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
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
vi.mock("~/state/projects", () => ({ projectEnvironment: { writeFile: {} } }));
vi.mock("~/state/session", () => ({ readEnvironmentScope: () => runtime.canWrite }));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => write }));
const write = (request: Request) => runtime.write!(request);
vi.mock("~/scient/markdownEditor/persistence/markdownPersistenceTransport", () => ({
  classifyMarkdownPersistenceFailure: () => runtime.kind,
  createMarkdownPersistenceTransport: () => ({
    read: () => runtime.read!(),
    readForReview: () => runtime.read!(),
    resolve: (review: { recoveryId: string; currentRevision: string | null }) =>
      runtime.resolve!(review),
  }),
}));
vi.mock("~/scient/markdownEditor/persistence/documentFailureReason", () => ({
  describeDocumentPublicationAttention: () => null,
  documentPublicationOutcome: () => (runtime.kind === "target_changed" ? "unchanged" : null),
}));
vi.mock("~/rpc/atomRegistry", () => ({ appAtomRegistry: { refresh: () => {} } }));
vi.mock("./projectFilesQueryState", () => ({
  setProjectFileQueryData: (_environment: unknown, _cwd: string, _path: string, source: string) => {
    runtime.projectedSource = source;
  },
  confirmProjectFileQueryData: (
    _environment: unknown,
    _cwd: string,
    _path: string,
    source: string,
  ) => runtime.projectedSource === source,
  getProjectFileQueryAtom: () => "query",
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
let renderer: ReactTestRenderer | null = null;
function SurfaceActions(_props: { actions: FileSaveSessionActions }) {
  return null;
}
function Surface(input: FileSaveOptions) {
  return <SurfaceActions actions={useFileSaveCoordinator(input)} />;
}
function actions(): FileSaveSessionActions {
  return renderer!.root.findByType(SurfaceActions).props.actions;
}
async function mount(input = props) {
  await act(async () => {
    renderer = create(
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
    renderer!.unmount();
    renderer = null;
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
    renderer?.unmount();
    renderer = null;
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
