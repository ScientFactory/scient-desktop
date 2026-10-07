import "fake-indexeddb/auto";
import { EnvironmentId, ThreadId, MessageId, CommandId } from "@t3tools/contracts";
import { initializeExtractedIntent, readExtractedIntent } from "./editJournal";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import {
  acknowledgeQueueSubmission,
  queueSubmissionId,
  composerSubmissionMatchesDraft,
  bindExtractedSubmission,
  readExtractedSubmission,
  consumeExtractedSubmission,
  extractedDraftFingerprint,
} from "./submission";
import { createEmptyThreadDraft } from "../../composerDraftStore";

function createLocalStorageStub(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => {
      store.set(key, value);
    },
    removeItem: (key) => {
      store.delete(key);
    },
    clear: () => {
      store.clear();
    },
    key: (index) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
  };
}

const target = "environment-1:thread-1";
const payload = { text: "hello", attachments: [] };
const globals = globalThis as typeof globalThis & { localStorage?: Storage };
let originalLocalStorage: Storage | undefined;
const originalCrypto = globalThis.crypto;

beforeEach(() => {
  originalLocalStorage = globals.localStorage;
  globals.localStorage = createLocalStorageStub();
});

afterEach(() => {
  if (originalLocalStorage === undefined) delete globals.localStorage;
  else globals.localStorage = originalLocalStorage;
  Object.defineProperty(globalThis, "crypto", {
    value: originalCrypto,
    configurable: true,
    writable: true,
  });
});

/** Drops `crypto.subtle` the way a non-secure context (plain-HTTP remote access) does. */
function withoutWebCrypto() {
  Object.defineProperty(globalThis, "crypto", {
    value: { getRandomValues: originalCrypto.getRandomValues.bind(originalCrypto) },
    configurable: true,
    writable: true,
  });
}

describe("queueSubmissionId", () => {
  it("reuses one identity for an unacknowledged retry of the same payload", async () => {
    const first = await queueSubmissionId(target, payload);
    expect(await queueSubmissionId(target, payload)).toBe(first);
  });

  it("issues a new identity once the payload changes", async () => {
    const first = await queueSubmissionId(target, payload);
    expect(await queueSubmissionId(target, { ...payload, text: "hello again" })).not.toBe(first);
  });

  it("issues a new identity after the previous submission is acknowledged", async () => {
    const first = await queueSubmissionId(target, payload);
    acknowledgeQueueSubmission(target, first);
    expect(await queueSubmissionId(target, payload)).not.toBe(first);
  });

  it("uses the existing SHA-256 receipt when Web Crypto is unavailable", async () => {
    const first = await queueSubmissionId(target, payload);
    withoutWebCrypto();
    expect(await queueSubmissionId(target, payload)).toBe(first);
  });

  it("scopes retries to the owning thread and environment", async () => {
    const first = await queueSubmissionId(target, payload);
    expect(await queueSubmissionId("environment-1:thread-2", payload)).not.toBe(first);
    expect(await queueSubmissionId("environment-2:thread-1", payload)).not.toBe(first);
    expect(await queueSubmissionId(target, payload)).toBe(first);
  });

  it("keeps working without Web Crypto, as on plain-HTTP remote access", async () => {
    withoutWebCrypto();
    const first = await queueSubmissionId(target, payload);
    expect(first).toMatch(/^qitem_/);
    expect(await queueSubmissionId(target, payload)).toBe(first);
    expect(await queueSubmissionId(target, { ...payload, text: "changed" })).not.toBe(first);
  });

  it("retains an earlier ambiguous submission while a different draft is submitted", async () => {
    const first = await queueSubmissionId(target, payload);
    const secondPayload = { ...payload, text: "new draft" };
    const second = await queueSubmissionId(target, secondPayload);
    expect(second).not.toBe(first);
    expect(await queueSubmissionId(target, payload)).toBe(first);
    acknowledgeQueueSubmission(target, second);
    expect(await queueSubmissionId(target, payload)).toBe(first);
    expect(await queueSubmissionId(target, secondPayload)).not.toBe(second);
  });
});

describe("accepted submission draft ownership", () => {
  it("ignores upload receipt metadata but never clears later typing or attachment changes", () => {
    const file = new File(["notes"], "notes.txt", { type: "text/plain" });
    const submitted = {
      ...createEmptyThreadDraft(),
      prompt: "inspect",
      files: [
        {
          type: "file" as const,
          id: "notes",
          name: file.name,
          mimeType: file.type,
          sizeBytes: file.size,
          file,
        },
      ],
    };
    const uploaded = {
      ...submitted,
      files: [{ ...submitted.files[0]!, uploadedAttachmentId: "upload-finished" }],
    };
    expect(composerSubmissionMatchesDraft(submitted, uploaded)).toBe(true);
    expect(
      composerSubmissionMatchesDraft(submitted, { ...uploaded, prompt: "late transcript" }),
    ).toBe(false);
    expect(composerSubmissionMatchesDraft(submitted, { ...uploaded, files: [] })).toBe(false);
    expect(
      composerSubmissionMatchesDraft(submitted, {
        ...uploaded,
        files: [
          { ...uploaded.files[0]!, file: new File(["different"], file.name, { type: file.type }) },
        ],
      }),
    ).toBe(false);
  });
});

it("freezes the prepared attachment packet, settings and identity across an unknown ACK, then consumes once", async () => {
  const id = "44444444-4444-4444-8444-444444444444";
  const record = await initializeExtractedIntent(id);
  const draft = { ...createEmptyThreadDraft(), prompt: "same text" };
  const fingerprint = await extractedDraftFingerprint(draft);
  const packet = {
    environmentId: EnvironmentId.make("own"),
    input: {
      commandId: CommandId.make(`extracted-intent:${id}`),
      threadId: ThreadId.make("captured-target"),
      createdAt: "2026-10-05T00:00:00.000Z",
      runtimeMode: "full-access" as const,
      interactionMode: "default" as const,
      selectedScientSkillNames: ["analysis"],
      message: {
        messageId: MessageId.make("fixed-message"),
        role: "user" as const,
        text: "same text",
        attachments: [
          {
            type: "image" as const,
            name: "one.png",
            mimeType: "image/png",
            sizeBytes: 1,
            dataUrl: "data:image/png;base64,YQ==",
          },
        ],
      },
    },
  };
  await bindExtractedSubmission(record, packet, fingerprint, "bound-journal");
  const recovered = (await readExtractedIntent(id))!;
  expect(readExtractedSubmission(recovered)).toEqual(packet);
  await expect(
    bindExtractedSubmission(
      recovered,
      { ...packet, input: { ...packet.input, createdAt: "2026-10-06T00:00:00.000Z" } },
      fingerprint,
      "bound-journal",
    ),
  ).rejects.toThrow("frozen");
  await consumeExtractedSubmission(recovered);
  expect(await readExtractedIntent(id)).toMatchObject({
    phase: "consumed",
    consumedCommandId: packet.input.commandId,
  });
  expect((await readExtractedIntent(id))?.packetJson).toBeUndefined();
  await expect(
    bindExtractedSubmission(recovered, packet, fingerprint, "bound-journal"),
  ).rejects.toThrow("already submitted");
});
it("preserves later settings and thread context while accepted content is cleaned up", () => {
  const submitted = createEmptyThreadDraft();
  expect(
    composerSubmissionMatchesDraft(submitted, { ...submitted, runtimeMode: "full-access" }),
  ).toBe(false);
  expect(composerSubmissionMatchesDraft(submitted, { ...submitted, interactionMode: "plan" })).toBe(
    false,
  );
});
