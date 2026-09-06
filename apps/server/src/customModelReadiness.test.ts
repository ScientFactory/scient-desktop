import { describe, expect, it } from "vite-plus/test";
import {
  ProviderInstanceId,
  customModelAttachmentKey,
  supportsModelConnections,
} from "@t3tools/contracts";
import * as Redacted from "effect/Redacted";
import { assessModelConnections } from "./customModelReadiness.ts";
import type { ResolvedModelConnection } from "./customModels.ts";

const connection: ResolvedModelConnection = {
  id: "connection",
  name: "Fixture",
  protocol: "openai-responses",
  baseUrl: "https://api.openai.com/v1",
  credentialId: "opaque",
  apiKey: Redacted.make("synthetic-secret"),
  models: [
    {
      id: "saved",
      modelId: "exact",
      name: "Model",
      configurationMode: "automatic",
      images: false,
      reasoning: false,
      instanceIds: [ProviderInstanceId.make("pi"), ProviderInstanceId.make("droid")],
    },
  ],
};
describe("model connection assessment", () => {
  it("retains unavailable rows and separates agents, availability, and account validation", () => {
    const pi = assessModelConnections([connection], () => ({
      contextWindow: 272000,
      maxOutputTokens: 128000,
      source: "agent",
    }));
    const droid = assessModelConnections([connection], () => ({ source: "agent" }));
    const missing = assessModelConnections([connection], () => undefined);
    expect(pi[0]).toMatchObject({ state: "available", contextWindow: 272000, source: "agent" });
    expect(droid[0]).toMatchObject({ state: "available", source: "agent" });
    expect(droid[0]!.contextWindow).toBeUndefined();
    expect(missing[0]).toMatchObject({ state: "needs_setup", reason: "model_unavailable" });
    expect(JSON.stringify([pi, droid, missing])).not.toContain("synthetic-secret");
    expect(JSON.stringify(pi)).not.toContain("authenticated");
  });
  it("never reports an unreadable key as keyless or available", () => {
    const { apiKey: _key, ...saved } = connection;
    expect(
      assessModelConnections([{ ...saved, credentialError: "unavailable" }], () => ({}))[0],
    ).toMatchObject({ state: "needs_setup", reason: "credential" });
  });
  it("invalidates old assessments for edits and rotation but not unrelated attachments", () => {
    const model = connection.models[0]!;
    const key = customModelAttachmentKey(connection, model);
    expect(customModelAttachmentKey(connection, { ...model, instanceIds: [] })).toBe(key);
    expect(customModelAttachmentKey({ ...connection, credentialId: "rotated" }, model)).not.toBe(
      key,
    );
    expect(customModelAttachmentKey(connection, { ...model, contextWindow: 500000 })).not.toBe(key);
    const evidenced = {
      ...model,
      reasoningMetadata: {
        status: "known" as const,
        source: "provider" as const,
        checkedAt: "2026-09-01T00:00:00.000Z",
        stale: false,
        supported: true,
        levels: ["high" as const],
      },
    };
    expect(
      customModelAttachmentKey(connection, {
        ...evidenced,
        reasoningMetadata: {
          ...evidenced.reasoningMetadata,
          checkedAt: "2026-09-06T00:00:00.000Z",
          stale: true,
        },
      }),
    ).toBe(customModelAttachmentKey(connection, evidenced));
  });
  it("uses the same bounded eligibility on browser and server", () => {
    for (const driver of ["pi", "droid"])
      for (const protocol of [
        "openai-responses",
        "openai-completions",
        "anthropic-messages",
      ] as const)
        expect(supportsModelConnections(driver, protocol)).toBe(true);
    for (const driver of ["codex", "opencode", undefined, "future-agent"])
      expect(supportsModelConnections(driver)).toBe(false);
  });
});
