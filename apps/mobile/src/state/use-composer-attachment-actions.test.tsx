import { act, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  ChatAttachmentId,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  type ChatAttachment,
  type ServerConfig,
} from "@t3tools/contracts";
import type { DraftComposerAttachment } from "../lib/composerImages";

const intake = vi.hoisted(() => ({
  pick: vi.fn(),
  media: vi.fn(),
  images: vi.fn(),
  text: vi.fn(),
  remove: vi.fn(async () => {}),
  cleanup: vi.fn(),
  alert: vi.fn(),
  append: vi.fn(),
  drafts: new Map<string, { text: string; attachments: ReadonlyArray<DraftComposerAttachment> }>(),
  edits: {} as Record<
    string,
    { runId: string; existingAttachments: ReadonlyArray<ChatAttachment> }
  >,
}));
vi.mock("../components/ui/Dialog", () => ({ alert: intake.alert }));
vi.mock("../lib/composerImages", () => ({
  pickComposerFiles: intake.pick,
  pickComposerMedia: intake.media,
  convertPastedImagesToAttachments: intake.images,
  createPastedTextComposerAttachment: intake.text,
  removePersistedComposerAttachmentFile: intake.remove,
  isComposerImageAttachment: (attachment: DraftComposerAttachment) => attachment.type === "image",
  isFileBackedComposerAttachment: (attachment: DraftComposerAttachment) =>
    attachment.fileUri !== undefined,
}));
vi.mock("../lib/uuid", () => ({ uuidv4: () => "attachment-test" }));
vi.mock("../lib/composerAttachmentPreviewRetention", () => ({
  retainComposerAttachmentFileForPreview: () => () => {},
}));
vi.mock("./atom-registry", () => ({ appAtomRegistry: { get: () => intake.edits } }));
vi.mock("./assets", () => ({ assetEnvironment: {} }));
vi.mock("./attachments", () => ({ attachmentEnvironment: {} }));
vi.mock("./session", () => ({
  environmentSession: {},
  readEnvironmentScope: () => true,
}));
vi.mock("./queued-run-edit", async () => ({
  queuedRunEditsAtom: Symbol("queued-edits"),
  queuedEditDraftKey: (await import("./queued-edit-draft-key")).queuedEditDraftKey,
}));
vi.mock("./use-composer-drafts", () => {
  const snapshot = (key: string) => intake.drafts.get(key) ?? { text: "", attachments: [] };
  return {
    captureComposerDraftInsertion: (key: string) => ({
      text: snapshot(key).text,
      selectionStart: 0,
      selectionEnd: 0,
    }),
    countComposerDraftAttachmentsAfterSelection: (key: string) => snapshot(key).attachments.length,
    getComposerDraftSnapshot: snapshot,
    getComposerDraftAfterSelection: snapshot,
    scheduleUnusedComposerAttachmentCleanup: intake.cleanup,
    appendComposerDraftAttachments: intake.append,
  };
});

import { queuedEditDraftKey } from "./queued-edit-draft-key";
import { useComposerAttachmentActions } from "./use-composer-attachment-actions";

type Props = Parameters<typeof useComposerAttachmentActions>[0];

function file(id: string): DraftComposerAttachment {
  return {
    id,
    type: "file",
    name: `${id}.txt`,
    mimeType: "text/plain",
    sizeBytes: 10,
    fileUri: `file:///documents/${id}.txt`,
  };
}

function retained(id: string): ChatAttachment {
  return {
    id: ChatAttachmentId.make(id),
    type: "file",
    name: `${id}.txt`,
    mimeType: "text/plain",
    sizeBytes: 10,
  };
}

function setup(resolveDraftKey?: Props["resolveDraftKey"]) {
  vi.clearAllMocks();
  intake.drafts.clear();
  intake.edits = {};
  intake.append.mockImplementation(
    (key: string, attachments: ReadonlyArray<DraftComposerAttachment>) => {
      const current = intake.drafts.get(key) ?? { text: "", attachments: [] };
      intake.drafts.set(key, { ...current, attachments: [...current.attachments, ...attachments] });
      return 0;
    },
  );
  const globals = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean | undefined;
  };
  const previousActEnvironment = globals.IS_REACT_ACT_ENVIRONMENT;
  globals.IS_REACT_ACT_ENVIRONMENT = true;
  const root = createRoot(document.createElement("div"));
  let actions!: ReturnType<typeof useComposerAttachmentActions>;
  function Probe(props: Props) {
    const current = useComposerAttachmentActions(props);
    useLayoutEffect(() => {
      actions = current;
    });
    return null;
  }
  const serverConfig = {
    environment: {
      capabilities: {
        attachmentUploads: true,
        fileAttachments: { maxUploadBytes: 50 * 1024 * 1024 },
      },
    },
  } as ServerConfig;
  const render = (draftKey: string) => {
    act(() =>
      root.render(
        <Probe
          draftKey={draftKey}
          serverConfig={serverConfig}
          {...(resolveDraftKey ? { resolveDraftKey } : {})}
        />,
      ),
    );
  };
  render("env:thread");
  return {
    get actions() {
      return actions;
    },
    render,
    [Symbol.dispose]() {
      act(() => root.unmount());
      globals.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
    },
  };
}

describe("composer attachment intake ownership", () => {
  it.each(["native-first", "clipboard-first"])(
    "reserves distinct filenames before concurrent native and clipboard paste I/O (%s)",
    async (order) => {
      using screen = setup();
      const prepared = Promise.withResolvers<DraftComposerAttachment>();
      intake.text.mockImplementationOnce(({ name }: { name: string }) =>
        prepared.promise.then((attachment) => ({ ...attachment, name })),
      );
      const clipboardName =
        order === "clipboard-first"
          ? screen.actions.reservePastedTextFileName("env:thread", [])
          : null;
      const pending = screen.actions.onNativePasteText({
        text: "native pasted text",
        eventCount: 1,
        value: "",
        selection: { start: 0, end: 0 },
      });
      const reservedClipboardName =
        clipboardName ?? screen.actions.reservePastedTextFileName("env:thread", []);
      const nativeName = intake.text.mock.calls[0]![0].name;
      expect(nativeName).not.toBe(reservedClipboardName);
      expect(new Set([nativeName, reservedClipboardName])).toEqual(
        new Set(["pasted-text.txt", "pasted-text-2.txt"]),
      );
      prepared.resolve(file("native"));
      await pending;
      expect(intake.drafts.get("env:thread")?.attachments[0]?.name).toBe(nativeName);
    },
  );

  it("checks the retained queued attachments that exist when the picker finishes", async () => {
    const editKey = queuedEditDraftKey("env:thread", "run");
    using screen = setup(() => editKey);
    const picked = Promise.withResolvers<{
      files: ReadonlyArray<DraftComposerAttachment>;
      error: null;
    }>();
    intake.pick.mockReturnValueOnce(picked.promise);
    const pending = screen.actions.onPickDraftFiles();
    intake.edits = {
      "env:thread": {
        runId: "run",
        existingAttachments: Array.from({ length: PROVIDER_SEND_TURN_MAX_ATTACHMENTS }, (_, i) =>
          retained(`kept-${i}`),
        ),
      },
    };
    const attachment = file("new");
    picked.resolve({ files: [attachment], error: null });
    await pending;
    expect(intake.append).not.toHaveBeenCalled();
    expect(intake.cleanup).toHaveBeenCalledWith([attachment]);
    expect(intake.alert).toHaveBeenCalledWith("Could not attach file", expect.any(String));
  });

  it("resolves a queued edit at invocation even for an older native callback", async () => {
    let activeKey = "env:thread";
    using screen = setup(() => activeKey);
    const callback = screen.actions.onPickDraftFiles;
    activeKey = queuedEditDraftKey("env:thread", "run");
    const attachment = file("edit");
    intake.pick.mockResolvedValueOnce({ files: [attachment], error: null });
    await callback();
    expect(intake.drafts.get(activeKey)?.attachments).toEqual([attachment]);
    expect(intake.drafts.has("env:thread")).toBe(false);
  });

  it("discards picker output after its queued edit closes without writing the ordinary draft", async () => {
    let activeKey = queuedEditDraftKey("env:thread", "run");
    using screen = setup(() => activeKey);
    const picked = Promise.withResolvers<{
      files: ReadonlyArray<DraftComposerAttachment>;
      error: null;
    }>();
    intake.pick.mockReturnValueOnce(picked.promise);
    const pending = screen.actions.onPickDraftFiles();
    activeKey = "env:thread";
    const attachment = file("closed");
    picked.resolve({ files: [attachment], error: null });
    await pending;
    expect(intake.append).not.toHaveBeenCalled();
    expect(intake.remove).toHaveBeenCalledWith(attachment.fileUri);
  });

  it("cleans up a picker result after changing drafts", async () => {
    using screen = setup();
    const picked = Promise.withResolvers<{
      files: ReadonlyArray<DraftComposerAttachment>;
      error: null;
    }>();
    intake.pick.mockReturnValueOnce(picked.promise);
    const pending = screen.actions.onPickDraftFiles();
    screen.render("env:other");
    const attachment = file("departed");
    picked.resolve({ files: [attachment], error: null });
    await pending;
    expect(intake.append).not.toHaveBeenCalled();
    expect(intake.remove).toHaveBeenCalledWith(attachment.fileUri);
  });

  it("admits concurrent picker results against the latest committed draft", async () => {
    using screen = setup();
    intake.drafts.set("env:thread", {
      text: "",
      attachments: Array.from({ length: PROVIDER_SEND_TURN_MAX_ATTACHMENTS - 1 }, (_, i) =>
        file(`existing-${i}`),
      ),
    });
    const first = Promise.withResolvers<{
      files: ReadonlyArray<DraftComposerAttachment>;
      error: null;
    }>();
    const second = Promise.withResolvers<{
      files: ReadonlyArray<DraftComposerAttachment>;
      error: null;
    }>();
    intake.pick.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const firstPending = screen.actions.onPickDraftFiles();
    const secondPending = screen.actions.onPickDraftFiles();
    first.resolve({ files: [file("first")], error: null });
    await firstPending;
    const rejected = file("second");
    second.resolve({ files: [rejected], error: null });
    await secondPending;
    expect(intake.append).toHaveBeenCalledTimes(1);
    expect(intake.cleanup).toHaveBeenCalledWith([rejected]);
    expect(intake.drafts.get("env:thread")?.attachments).toHaveLength(
      PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
    );
  });
});
