import { describe, expect, it } from "@effect/vitest";

import { durationBucket, modelKey, normalizedKeys, normalizeInheritedEvent } from "./contract.ts";
import { ANALYTICS_CONTRACT_REVISION, eventContractViolation } from "./wireContract.ts";

const context = {
  appVersion: "0.0.32",
  buildChannel: "development" as const,
};

describe("Scient analytics contract", () => {
  it("does not turn inherited terminal notifications into duplicate successes", () => {
    for (const terminalStatus of ["completed", "failed", "cancelled", "interrupted"]) {
      expect(
        normalizeInheritedEvent(
          "provider.turn.completed",
          { provider: "pi", terminalStatus },
          context,
        ),
      ).toMatchObject({
        name: "provider.turn.usage",
        privacyLevel: "product",
        properties: {
          terminalStatus:
            terminalStatus === "cancelled" || terminalStatus === "interrupted"
              ? "stopped"
              : terminalStatus,
          usageStatus: "unavailable",
        },
      });
    }
    expect(
      normalizeInheritedEvent("provider.turn.completed", { provider: "pi" }, context)?.name,
    ).toBe("provider.turn.completed");
  });
  it.each(["scient", "omp", "muse", "acpRegistry"])(
    "preserves the bounded %s driver across submission, usage and installation events",
    (provider) => {
      for (const name of [
        "provider.turn.sent",
        "provider.turn.completed",
        "provider.turn.usage",
        "provider.installation.observed",
        "provider.installation.changed",
        "provider.lifecycle.completed",
      ]) {
        const event = normalizeInheritedEvent(
          name,
          {
            provider,
            model: "gpt-6.1-luna",
            installed: true,
            fromInstalled: false,
            toInstalled: true,
            prompt: "PRIVATE-CONTENT",
            path: "/PRIVATE/PATH",
            workspace: "/Users/PRIVATE/project",
            endpoint: "https://PRIVATE.example",
          },
          context,
        );
        expect(event?.properties.provider).toBe(provider);
        expect(JSON.stringify(event)).not.toContain("PRIVATE");
        if (!event) throw new Error("Missing normalizer");
        expect(
          eventContractViolation({
            name: event.name,
            privacyLevel: event.privacyLevel,
            consentLevel: event.privacyLevel,
            properties: event.properties,
          }),
        ).toBeNull();
      }
    },
  );

  it("sends driver and model names as the code passes them, as T3 does", () => {
    const event = normalizeInheritedEvent(
      "provider.turn.sent",
      { provider: "newDriver", model: "lab-model-7b" },
      context,
    );
    expect(event?.properties).toMatchObject({
      provider: "newDriver",
      modelKey: "lab-model-7b",
      attachmentCountBucket: "unknown",
    });
    expect(event?.properties).not.toHaveProperty("hasInput");
    expect(
      normalizeInheritedEvent("provider.turn.sent", { hasInput: false }, context)?.properties
        .hasInput,
    ).toBe(false);
    const freeText = normalizeInheritedEvent(
      "provider.turn.sent",
      { provider: "a sentence, not a driver", model: "Not A Model Id!" },
      context,
    );
    expect(freeText?.properties).toMatchObject({ provider: "other", modelKey: "other" });
  });

  it("attributes Pi and its model but never sends an endpoint address", () => {
    const event = normalizeInheritedEvent(
      "provider.turn.sent",
      {
        provider: "pi",
        model: "local-model",
        endpoint: "https://private.example",
      },
      context,
    );
    expect(event?.properties).toMatchObject({ provider: "pi", modelKey: "local-model" });
    expect(JSON.stringify(event)).not.toContain("private");
  });
  it("keeps skipped source imports distinct from success and failure without private details", () => {
    const skipped = normalizeInheritedEvent(
      "scient.operation.skipped",
      {
        operationKind: "source-import",
        trigger: "user",
        durationMs: 450,
        title: "PRIVATE_SOURCE",
        error: "PRIVATE_ERROR",
        file: "/Users/someone/PRIVATE.pdf",
      },
      context,
    );
    expect(skipped).toMatchObject({
      name: "scient.operation.skipped",
      privacyLevel: "product",
      priority: "core",
      properties: { operationKind: "source-import", trigger: "user", durationBucket: "under-1s" },
    });
    expect(JSON.stringify(skipped)).not.toContain("PRIVATE");
  });
  it("folds model aliases and pinned versions, and sends other model ids as they are", () => {
    expect(modelKey("gpt-5-codex")).toBe("gpt-5.4");
    expect(modelKey("claude-opus-4-6-20251117")).toBe("claude-opus-4-6");
    expect(modelKey("claude-opus-5-5")).toBe("claude-opus-5-5");
    expect(modelKey("anthropic/claude-opus-5-5")).toBe("claude-opus-5-5");
    expect(modelKey("lab-model-alpha")).toBe("lab-model-alpha");
    expect(modelKey("a model name with spaces")).toBe("other");
    expect(modelKey(undefined)).toBe("unknown");
  });

  it("uses bounded duration and failure values", () => {
    expect(durationBucket(450)).toBe("under-1s");
    expect(durationBucket(75_000)).toBe("1-3m");
    expect(durationBucket(Number.POSITIVE_INFINITY)).toBe("unknown");

    expect(
      normalizeInheritedEvent(
        "provider.turn.failed",
        {
          provider: "codex",
          model: "gpt-5.6-sol",
          durationMs: 75_000,
          failureClass: "a private raw error",
        },
        context,
      ),
    ).toMatchObject({
      properties: {
        modelKey: "gpt-5.6-sol",
        durationBucket: "1-3m",
        failureClass: "unknown",
      },
    });
  });

  it("records events and fields without a Scient normalizer, as T3 does", () => {
    expect(
      normalizeInheritedEvent("chatgpt.sign_in.completed", { outcome: "succeeded", n: 2 }, context),
    ).toEqual({
      name: "chatgpt.sign_in.completed",
      privacyLevel: "product",
      priority: "core",
      properties: {
        outcome: "succeeded",
        n: 2,
        ...context,
        contractRevision: ANALYTICS_CONTRACT_REVISION,
      },
    });
    const surface = normalizeInheritedEvent(
      "surface.opened",
      { surface: "settings", layout: "split", path: "/Users/private" },
      context,
    );
    expect(surface?.properties).toEqual({
      surface: "settings",
      layout: "split",
      ...context,
      contractRevision: ANALYTICS_CONTRACT_REVISION,
    });
    expect(normalizeInheritedEvent("Not An Event", {}, context)).toBeNull();
  });

  it("names the fields a normalizer uses; the rest pass through as recorded", () => {
    const properties = { provider: "codex", model: "gpt-5.6-sol", durationMs: 1200, requests: 3 };
    expect([...normalizedKeys("provider.turn.completed", properties, context)].toSorted()).toEqual([
      "durationMs",
      "model",
      "provider",
    ]);
    expect(
      normalizeInheritedEvent("provider.turn.completed", properties, context)?.properties,
    ).toMatchObject({ provider: "codex", modelKey: "gpt-5.6-sol", requests: 3 });
    expect([...normalizedKeys("chatgpt.sign_in.completed", { outcome: "ok" }, context)]).toEqual(
      [],
    );
  });

  it("never sends free text, paths, links, email addresses or nested objects", () => {
    const event = normalizeInheritedEvent(
      "provider.request.completed",
      {
        provider: "codex",
        serviceTier: "fast",
        inputTokens: 12,
        tags: ["a", "b"],
        prompt: "short",
        Message: "short",
        errorMessage: "short",
        file: "C:\\Users\\someone\\notes.txt",
        relative: "./notes/today.md",
        home: "~/notes",
        nestedPath: "data/Users/someone/x",
        link: "https://example.com/x",
        fileLink: "file:x",
        who: "someone@example.com",
        list: ["ok", "/etc/passwd"],
        long: "x".repeat(257),
        nested: { a: 1 },
        notFinite: Number.NaN,
        "bad key": 1,
      },
      context,
    );
    expect(event?.properties).toEqual({
      provider: "codex",
      serviceTier: "fast",
      inputTokens: 12,
      tags: ["a", "b"],
      ...context,
      contractRevision: ANALYTICS_CONTRACT_REVISION,
    });
  });

  it("keeps every event within the wire limits", () => {
    const many = Object.fromEntries(
      Array.from({ length: 100 }, (_, index) => [`field${index}`, "y".repeat(250)]),
    );
    const event = normalizeInheritedEvent("bulk.event", many, context);
    if (!event) throw new Error("Missing event");
    expect(
      eventContractViolation({
        name: event.name,
        privacyLevel: event.privacyLevel,
        consentLevel: event.privacyLevel,
        properties: event.properties,
      }),
    ).toBeNull();
    expect(event.properties.contractRevision).toBe(ANALYTICS_CONTRACT_REVISION);
  });

  it("reports thread and project counts on the startup heartbeat", () => {
    const valid = normalizeInheritedEvent(
      "server.boot.heartbeat",
      { threadCount: 84, projectCount: 6 },
      context,
    );
    expect(valid?.properties).toMatchObject({ threadCount: 84, projectCount: 6 });
    const invalid = normalizeInheritedEvent(
      "server.boot.heartbeat",
      { threadCount: -1, projectCount: "6" },
      context,
    );
    expect(invalid?.properties).not.toHaveProperty("threadCount");
    expect(invalid?.properties).not.toHaveProperty("projectCount");
  });

  it("accepts only hashed owner ids from a known source", () => {
    const ownerId = "a".repeat(64);
    expect(
      normalizeInheritedEvent(
        "install.owner_observed",
        { ownerSource: "claude", ownerId, observedBy: "server", email: "private@example.invalid" },
        context,
      )?.properties,
    ).toEqual({
      ownerSource: "claude",
      ownerId,
      observedBy: "server",
      ...context,
      contractRevision: ANALYTICS_CONTRACT_REVISION,
    });
    for (const properties of [
      { ownerSource: "claude", ownerId: "user-raw-account-id" },
      { ownerSource: "claude", ownerId: "A".repeat(64) },
      { ownerSource: "email", ownerId },
      {},
    ])
      expect(normalizeInheritedEvent("install.owner_observed", properties, context)).toBeNull();
  });

  it("keeps who started a turn on its usage event", () => {
    const usage = normalizeInheritedEvent(
      "provider.turn.completed",
      {
        provider: "codex",
        terminalStatus: "completed",
        createdBy: "agent",
        creationSource: "mcp",
        scheduled: true,
        subagent: false,
      },
      context,
    );
    expect(usage).toMatchObject({
      name: "provider.turn.usage",
      properties: { createdBy: "agent", creationSource: "mcp", scheduled: true, subagent: false },
    });
    const freeText = normalizeInheritedEvent(
      "provider.turn.completed",
      { provider: "codex", terminalStatus: "completed", createdBy: "some one" },
      context,
    );
    expect(freeText?.properties).not.toHaveProperty("createdBy");
  });

  it("records client and feature events without free text", () => {
    const turn = normalizeInheritedEvent(
      "client.turn.requested",
      {
        surface: "desktop",
        clientDeviceType: "desktop",
        clientOs: "macOS",
        connectionMethod: "direct",
        clientAppVersion: "9.9.9",
        appVersion: "9.9.9",
      },
      context,
    );
    expect(turn?.properties).toEqual({
      surface: "desktop",
      clientDeviceType: "desktop",
      clientOs: "macOS",
      connectionMethod: "direct",
      clientAppVersion: "9.9.9",
      ...context,
      contractRevision: ANALYTICS_CONTRACT_REVISION,
    });
    const feature = normalizeInheritedEvent(
      "feature.used",
      { feature: "checkpoint.rollback", variant: "with_files", surface: "web" },
      context,
    );
    expect(feature?.properties).toMatchObject({
      feature: "checkpoint.rollback",
      variant: "with_files",
      surface: "web",
    });
    const unsafe = normalizeInheritedEvent(
      "feature.used",
      { feature: "/Users/private/file", variant: "a private sentence" },
      context,
    );
    expect(unsafe?.properties).toMatchObject({ feature: "other", surface: "unknown" });
    expect(unsafe?.properties).not.toHaveProperty("variant");
  });

  it("measures agent tools without arguments or free text", () => {
    const tool = normalizeInheritedEvent(
      "mcp.tool.invoked",
      {
        tool: "delegate_task",
        callerProvider: "claudeAgent",
        callerModel: "lab-model",
        targetProvider: "codex",
        outcome: "error",
        errorCode: "a private error sentence",
        durationMs: 1200,
        crossProvider: true,
        prompt: "PRIVATE",
      },
      context,
    );
    expect(tool?.properties).toMatchObject({
      tool: "delegate_task",
      callerProvider: "claudeAgent",
      callerModel: "lab-model",
      targetProvider: "codex",
      outcome: "error",
      durationMs: 1200,
      crossProvider: true,
    });
    expect(JSON.stringify(tool)).not.toMatch(/private|PRIVATE/u);
    const finished = normalizeInheritedEvent(
      "mcp.delegated_task.finished",
      { status: "completed", callerProvider: "codex", targetProvider: "grok", durationSeconds: 90 },
      context,
    );
    expect(finished?.properties).toMatchObject({
      status: "completed",
      targetProvider: "grok",
      durationSeconds: 90,
    });
  });

  it("classifies project-registration failures without accepting raw errors", () => {
    const failure = normalizeInheritedEvent(
      "project.add.failed",
      { stage: "registration", error: "/private/path could not be created" },
      context,
    );
    expect(failure).toMatchObject({
      privacyLevel: "essential",
      priority: "critical",
      properties: { stage: "registration" },
    });
    expect(JSON.stringify(failure)).not.toContain("/private/path");
  });
});
