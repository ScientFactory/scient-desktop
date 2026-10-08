// @vitest-environment happy-dom
import { RegistryContext } from "@effect/atom-react";
import {
  AuthOrchestrationOperateScope,
  ChatAttachmentId,
  EnvironmentId,
  MessageId,
  RunId,
  sessionGrantsScope,
  type AuthEnvironmentScope,
  type SessionGrantInput,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import * as Option from "effect/Option";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { DraftComposerAttachment } from "../lib/composerImages";

const transport = vi.hoisted(() => ({
  verify: vi.fn(),
  command: vi.fn(),
  upload: vi.fn(),
  read: vi.fn(),
  sessions: new Map<EnvironmentId, SessionGrantInput>(),
}));
vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  createEnvironmentRpcCommand: () => Symbol("command"),
  executeAtomQuery: transport.verify,
  runAtomCommand: transport.command,
  squashAtomCommandFailure: (result: { readonly error: unknown }) => result.error,
}));
vi.mock("../lib/composerAttachmentPreviewRetention", () => ({
  retainComposerAttachmentFileForPreview: () => () => {},
}));
vi.mock("expo-crypto", () => ({ randomUUID: () => "00000000-0000-4000-8000-000000000001" }));
vi.mock("expo-file-system/legacy", () => ({
  documentDirectory: "file:///documents/",
  uploadAsync: transport.upload,
  readAsStringAsync: transport.read,
  UploadType: { BINARY_CONTENT: 0 },
}));
vi.mock("./session", () => {
  const connection = Atom.make(Option.some({ httpBaseUrl: "https://environment.example/" }));
  const readEnvironmentScope = (environmentId: EnvironmentId, scope: AuthEnvironmentScope) => {
    const session = transport.sessions.get(environmentId);
    return session !== undefined && sessionGrantsScope(session, scope);
  };
  return {
    environmentSession: { preparedConnectionValueAtom: () => connection },
    readEnvironmentScope,
    useEnvironmentsWithScope: (
      environments: ReadonlyArray<{ readonly environmentId: EnvironmentId }>,
      scope: AuthEnvironmentScope,
    ) =>
      new Set(
        environments
          .filter(({ environmentId }) => readEnvironmentScope(environmentId, scope))
          .map(({ environmentId }) => environmentId),
      ),
  };
});
vi.mock("./assets", () => ({ assetEnvironment: { createUrl: (input: unknown) => input } }));
vi.mock("./attachments", () => ({
  attachmentEnvironment: { createUploadUrl: Symbol("upload"), remove: Symbol("remove") },
}));
vi.mock("./use-composer-drafts", () => ({
  composerDraftsAtom: Atom.make<
    Readonly<
      Record<
        string,
        { readonly text: string; readonly attachments: ReadonlyArray<DraftComposerAttachment> }
      >
    >
  >({}).pipe(Atom.keepAlive),
  ensureComposerDraftsLoaded: () => {},
  flushComposerDrafts: async () => {},
  setComposerDraftAttachmentUpload: vi.fn(),
  clearComposerDraft: () => {},
  setComposerDraftContext: () => {},
  setComposerDraftText: () => {},
}));
vi.mock("./thread-outbox", () => ({
  threadOutboxManager: { queuedMessagesByThreadKeyAtom: Atom.make({}).pipe(Atom.keepAlive) },
  flattenQueuedThreadMessages: () => [],
}));
vi.mock("./use-thread-outbox", () => ({ useThreadOutboxMessages: () => ({}) }));
vi.mock("./entities", () => ({
  useServerConfigs: () =>
    new Map([
      [
        EnvironmentId.make("env"),
        {
          environment: {
            capabilities: {
              attachmentUploads: true,
              fileAttachments: { maxUploadBytes: 50 * 1024 * 1024 },
            },
          },
        },
      ],
    ]),
}));
vi.mock("./use-remote-environment-registry", () => ({
  useRemoteConnectionStatus: () => ({
    connectedEnvironments: [
      { environmentId: EnvironmentId.make("env"), connectionState: "connected" },
    ],
  }),
}));

import { appAtomRegistry } from "./atom-registry";
import { composerDraftsAtom } from "./use-composer-drafts";
import { queuedEditDraftKey, queuedRunEditsAtom } from "./queued-run-edit";
import {
  composerAttachmentUploadsAtom,
  retryComposerAttachmentUpload,
  useComposerAttachmentUploadWorker,
} from "./composer-attachment-uploads";
import { composerAttachmentUploadKey } from "../lib/composerAttachmentUploadQueue";

const environmentId = EnvironmentId.make("env");
const threadKey = "env:thread";
const images = (count: number): DraftComposerAttachment[] =>
  Array.from({ length: count }, (_, index) => ({
    type: "image",
    id: `image-${index}`,
    name: `image-${index}.png`,
    mimeType: "image/png",
    sizeBytes: 10 * 1024 * 1024,
    fileUri: `file:///documents/t3-composer-attachments/image-${index}.png`,
    previewUri: `file:///documents/t3-composer-attachments/image-${index}.png`,
    uploadedAttachmentId: `pending-image-${index}`,
    uploadEnvironmentId: environmentId,
  }));
let root: Root;
function Probe() {
  useComposerAttachmentUploadWorker();
  return null;
}
function statuses(count: number, status: "failed" | "ready") {
  const settled = Promise.withResolvers<void>();
  let unsubscribe = () => {};
  const check = () => {
    const values = Object.values(appAtomRegistry.get(composerAttachmentUploadsAtom));
    if (values.length === count && values.every((value) => value.status === status)) {
      unsubscribe();
      settled.resolve();
    }
  };
  unsubscribe = appAtomRegistry.subscribe(composerAttachmentUploadsAtom, check);
  check();
  return { done: settled.promise, dispose: () => unsubscribe() };
}
async function mount() {
  await act(() =>
    root.render(
      <RegistryContext.Provider value={appAtomRegistry}>
        <Probe />
      </RegistryContext.Provider>,
    ),
  );
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  transport.sessions.clear();
  transport.sessions.set(environmentId, {
    authenticated: true,
    scopes: [AuthOrchestrationOperateScope],
    permissions: [AuthOrchestrationOperateScope],
  });
  transport.verify.mockResolvedValue({ _tag: "Success", value: {} });
  appAtomRegistry.set(composerDraftsAtom, {});
  appAtomRegistry.set(queuedRunEditsAtom, {});
  root = createRoot(document.createElement("div"));
});
afterEach(async () => {
  await act(() => root.unmount());
  vi.unstubAllGlobals();
});

describe("mounted composer background attachment preparation", () => {
  it("retains a connected target's draft without preparing or retrying uploads when its operation grant is absent", async () => {
    transport.sessions.set(environmentId, {
      authenticated: true,
      scopes: [AuthOrchestrationOperateScope],
      permissions: [],
    });
    const draft = { text: "Keep denied target draft", attachments: images(1) };
    appAtomRegistry.set(composerDraftsAtom, { [threadKey]: draft });
    await mount();
    await act(() => retryComposerAttachmentUpload(environmentId, "image-0"));
    expect(transport.verify).not.toHaveBeenCalled();
    expect(transport.command).not.toHaveBeenCalled();
    expect(transport.upload).not.toHaveBeenCalled();
    expect(transport.read).not.toHaveBeenCalled();
    expect(appAtomRegistry.get(composerDraftsAtom)[threadKey]).toBe(draft);
    expect(appAtomRegistry.get(composerAttachmentUploadsAtom)).toEqual({});
  });
  it("refuses nine images before verification/upload and retries the same preserved draft after trimming to eight", async () => {
    const draft = { text: "Keep recovered draft", attachments: images(9) };
    appAtomRegistry.set(composerDraftsAtom, { [threadKey]: draft });
    const failed = statuses(9, "failed");
    const attemptedRead = Promise.withResolvers<void>();
    transport.verify.mockImplementation(async () => {
      attemptedRead.resolve();
      return { _tag: "Success", value: {} };
    });
    await mount();
    await act(async () => {
      await Promise.race([failed.done, attemptedRead.promise]);
    });
    failed.dispose();
    expect(transport.verify).not.toHaveBeenCalled();
    expect(transport.upload).not.toHaveBeenCalled();
    expect(transport.read).not.toHaveBeenCalled();
    expect(transport.command).not.toHaveBeenCalled();
    expect(appAtomRegistry.get(composerDraftsAtom)[threadKey]).toBe(draft);
    expect(
      appAtomRegistry.get(composerAttachmentUploadsAtom)[
        composerAttachmentUploadKey(environmentId, "image-0")
      ],
    ).toEqual({ status: "failed", reason: expect.stringContaining("80 MiB") });
    const ready = statuses(8, "ready");
    await act(() => {
      appAtomRegistry.set(composerDraftsAtom, {
        [threadKey]: { ...draft, attachments: draft.attachments.slice(0, 8) },
      });
    });
    await act(async () => {
      for (const attachment of draft.attachments.slice(0, 8))
        retryComposerAttachmentUpload(environmentId, attachment.id);
      await ready.done;
    });
    expect(transport.verify).toHaveBeenCalledTimes(8);
    expect(transport.upload).not.toHaveBeenCalled();
    expect(appAtomRegistry.get(composerDraftsAtom)[threadKey]?.text).toBe(draft.text);
  });

  it("includes retained queued references in the owning edit before its new file can upload", async () => {
    const retained = images(8).map((item) => ({
      type: "image" as const,
      id: ChatAttachmentId.make(`retained-${item.id}`),
      name: item.name,
      mimeType: "image/png" as const,
      sizeBytes: item.sizeBytes,
    }));
    const edit = {
      runId: RunId.make("queued-run"),
      messageId: MessageId.make("queued-message"),
      originalText: "Keep queued edit",
      existingAttachments: retained,
    };
    const draftKey = queuedEditDraftKey(threadKey, edit.runId);
    const draft = { text: edit.originalText, attachments: images(1) };
    appAtomRegistry.set(queuedRunEditsAtom, { [threadKey]: edit });
    appAtomRegistry.set(composerDraftsAtom, { [draftKey]: draft });
    const failed = statuses(1, "failed");
    const attemptedRead = Promise.withResolvers<void>();
    transport.verify.mockImplementation(async () => {
      attemptedRead.resolve();
      return { _tag: "Success", value: {} };
    });
    await mount();
    await act(async () => {
      await Promise.race([failed.done, attemptedRead.promise]);
    });
    failed.dispose();
    expect(transport.verify).not.toHaveBeenCalled();
    expect(transport.command).not.toHaveBeenCalled();
    expect(transport.upload).not.toHaveBeenCalled();
    expect(appAtomRegistry.get(composerDraftsAtom)[draftKey]).toBe(draft);
    expect(appAtomRegistry.get(queuedRunEditsAtom)[threadKey]).toBe(edit);
  });
});
