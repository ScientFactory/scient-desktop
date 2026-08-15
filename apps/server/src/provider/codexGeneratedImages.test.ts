import { describe, expect, it } from "vite-plus/test";
import { EventId, ProviderDriverKind, ThreadId } from "@t3tools/contracts";

import {
  CODEX_GENERATED_IMAGE_ARTIFACT_KIND,
  codexGeneratedImageArtifactFromProviderEvent,
  sanitizeCodexGeneratedImagePayload,
} from "./codexGeneratedImages.ts";

describe("Codex generated image normalization", () => {
  it("extracts compact durable metadata from a current imageGeneration item", () => {
    const event = {
      id: EventId.make("event-1"),
      kind: "notification" as const,
      provider: ProviderDriverKind.make("codex"),
      threadId: ThreadId.make("scient-thread"),
      createdAt: "2026-08-15T00:00:00.000Z",
      method: "item/completed",
      payload: {
        threadId: "provider-thread",
        item: {
          id: "image-call",
          type: "imageGeneration",
          savedPath: "/codex/generated_images/provider-thread/image-call.png",
          result: "large-inline-image",
        },
      },
    };

    expect(
      codexGeneratedImageArtifactFromProviderEvent({ event, item: event.payload.item }),
    ).toEqual({
      kind: CODEX_GENERATED_IMAGE_ARTIFACT_KIND,
      callId: "image-call",
      providerThreadId: "provider-thread",
      sourcePath: "/codex/generated_images/provider-thread/image-call.png",
    });
  });

  it("does not confuse an ordinary imageView with generated output", () => {
    const event = {
      id: EventId.make("event-2"),
      kind: "notification" as const,
      provider: ProviderDriverKind.make("codex"),
      threadId: ThreadId.make("scient-thread"),
      createdAt: "2026-08-15T00:00:00.000Z",
      method: "item/completed",
      payload: { item: { id: "view-1", type: "imageView", path: "/workspace/figure.svg" } },
    };

    expect(
      codexGeneratedImageArtifactFromProviderEvent({ event, item: event.payload.item }),
    ).toBeUndefined();
  });

  it("elides nested image bytes without mutating unrelated payloads", () => {
    const payload = {
      completedAtMs: 1,
      item: {
        id: "image-call",
        type: "imageGeneration",
        result: "large-inline-image",
        savedPath: "/tmp/image.png",
      },
    };
    const sanitized = sanitizeCodexGeneratedImagePayload(payload) as {
      item: Record<string, unknown>;
    };

    expect(sanitized.item.result).toBeUndefined();
    expect(sanitized.item.resultElidedForRelay).toBe(true);
    expect(sanitized.item.savedPath).toBe("/tmp/image.png");
    const ordinary = { item: { type: "imageView", result: "small metadata" } };
    expect(sanitizeCodexGeneratedImagePayload(ordinary)).toBe(ordinary);
  });
});
