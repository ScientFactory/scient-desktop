import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { useComposerDraftStore } from "~/composerDraftStore";
import type { ChatAttachment } from "~/types";
import {
  clearStagedUserForkDraft,
  prepareForkDraftAttachments,
  stageUserForkDraft,
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
});
