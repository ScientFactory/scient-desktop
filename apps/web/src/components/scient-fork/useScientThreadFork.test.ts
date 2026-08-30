import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { useComposerDraftStore } from "~/composerDraftStore";
import type { ChatAttachment } from "~/types";
import {
  clearStagedUserForkDraft,
  moveAcceptedForkComposerDraft,
  prepareForkDraftAttachments,
  stageUserForkDraft,
  userFacingForkError,
} from "./useScientThreadFork";

const destinationRef = scopeThreadRef(
  EnvironmentId.make("fork-draft-environment"),
  ThreadId.make("fork-draft-thread"),
);

const attachment: ChatAttachment = {
  type: "image",
  id: "origin-thread-00000000-0000-4000-8000-000000000001",
  name: "evidence.png",
  mimeType: "image/png",
  sizeBytes: 3,
  previewUrl: "https://local.test/authorized/evidence.png",
};

function resetComposerDraftStore() {
  useComposerDraftStore.setState({
    draftsByThreadKey: {},
    draftThreadsByThreadKey: {},
    logicalProjectDraftThreadKeyByLogicalProjectKey: {},
    stickyModelSelectionByProvider: {},
    stickyActiveProvider: null,
  });
}

describe("user-message fork draft staging", () => {
  beforeEach(resetComposerDraftStore);

  it("explains the file editing limitation without suggesting waiting will fix it", () => {
    expect(
      userFacingForkError(
        new Error("fork draft attachment 'report.pdf' is not a supported image attachment"),
      ),
    ).toContain("Fork from a completed response");
    expect(
      userFacingForkError(new Error("fork draft attachment 'photo.png' has no authorized URL")),
    ).toContain("Wait for it to load");
  });

  it("prepares authorized images as persistable draft attachments", async () => {
    const fetchAsset: typeof fetch = async () =>
      new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { "content-type": "image/png" },
      });

    const prepared = await prepareForkDraftAttachments(
      [attachment],
      fetchAsset,
      async () => "data:image/png;base64,AQID",
    );

    expect(prepared[0]?.image.id).toBe(attachment.id);
    expect(prepared[0]?.persisted).toEqual({
      id: attachment.id,
      name: attachment.name,
      mimeType: attachment.mimeType,
      sizeBytes: 3,
      dataUrl: "data:image/png;base64,AQID",
    });
  });

  it("stages the selected request unsent and supports failed-command cleanup", async () => {
    await stageUserForkDraft({
      destinationRef,
      prompt: "Revise this request before sending",
      attachments: [],
    });

    const draft =
      useComposerDraftStore.getState().draftsByThreadKey[scopedThreadKey(destinationRef)];
    expect(draft?.prompt).toBe("Revise this request before sending");
    expect(draft?.images).toEqual([]);

    clearStagedUserForkDraft(destinationRef);
    expect(
      useComposerDraftStore.getState().draftsByThreadKey[scopedThreadKey(destinationRef)],
    ).toBeUndefined();
  });

  it("leaves no partial draft when an authorized image cannot be read", async () => {
    const fetchAsset: typeof fetch = async () => new Response(null, { status: 403 });

    await expect(
      stageUserForkDraft({
        destinationRef,
        prompt: "Must not survive a failed preparation",
        attachments: [attachment],
        fetchAsset,
        readAsDataUrl: async () => "unused",
      }),
    ).rejects.toThrow("could not be read");

    expect(
      useComposerDraftStore.getState().draftsByThreadKey[scopedThreadKey(destinationRef)],
    ).toBeUndefined();
  });

  it("rejects non-image attachments without leaving a partial draft", async () => {
    const fileAttachment: ChatAttachment = {
      type: "file",
      id: "origin-thread-00000000-0000-4000-8000-000000000002",
      name: "notes.txt",
      mimeType: "text/plain",
      sizeBytes: 3,
      previewUrl: "https://local.test/authorized/notes.txt",
    };

    await expect(
      stageUserForkDraft({
        destinationRef,
        prompt: "Must not silently omit an unsupported attachment",
        attachments: [fileAttachment],
      }),
    ).rejects.toThrow("is not a supported image attachment");

    expect(
      useComposerDraftStore.getState().draftsByThreadKey[scopedThreadKey(destinationRef)],
    ).toBeUndefined();
  });
});

describe("accepted fork composer draft movement", () => {
  beforeEach(resetComposerDraftStore);

  it("moves portable unsent text and images into the accepted fork", () => {
    const sourceRef = scopeThreadRef(
      EnvironmentId.make("fork-draft-environment"),
      ThreadId.make("fork-draft-origin"),
    );
    const store = useComposerDraftStore.getState();
    store.setPrompt(sourceRef, "Continue this with another provider");
    store.addImages(sourceRef, [
      {
        type: "image",
        id: "draft-image",
        name: "draft.png",
        mimeType: "image/png",
        sizeBytes: 3,
        previewUrl: "blob:draft-image",
        file: new File([new Uint8Array([1, 2, 3])], "draft.png", { type: "image/png" }),
      },
    ]);

    moveAcceptedForkComposerDraft({ sourceRef, destinationRef });

    expect(store.getComposerDraft(sourceRef)).toBeNull();
    expect(store.getComposerDraft(destinationRef)?.prompt).toBe(
      "Continue this with another provider",
    );
    expect(store.getComposerDraft(destinationRef)?.images.map((image) => image.id)).toEqual([
      "draft-image",
    ]);
  });
});
