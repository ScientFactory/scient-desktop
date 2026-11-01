import { describe, expect, it } from "@effect/vitest";

import { durationBucket, modelKey, normalizeInheritedEvent } from "./contract.ts";
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
            model: "PRIVATE-MODEL",
            installed: true,
            fromInstalled: false,
            toInstalled: true,
            prompt: "PRIVATE-CONTENT",
            instanceId: "PRIVATE-INSTANCE",
            path: "/PRIVATE/PATH",
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

  it("keeps private/custom driver names other and absent input metadata unknown", () => {
    const event = normalizeInheritedEvent(
      "provider.turn.sent",
      { provider: "PRIVATE-DRIVER", model: "PRIVATE-MODEL" },
      context,
    );
    expect(event?.properties).toMatchObject({
      provider: "other",
      attachmentCountBucket: "unknown",
    });
    expect(event?.properties).not.toHaveProperty("hasInput");
    expect(JSON.stringify(event)).not.toContain("PRIVATE");
    expect(
      normalizeInheritedEvent("provider.turn.sent", { hasInput: false }, context)?.properties
        .hasInput,
    ).toBe(false);
  });

  it("attributes Pi without collecting custom endpoint or model names", () => {
    const event = normalizeInheritedEvent(
      "provider.turn.sent",
      {
        provider: "pi",
        model: "private-local-model",
        endpoint: "https://private.example",
      },
      context,
    );
    expect(event?.properties).toMatchObject({ provider: "pi", modelKey: "other" });
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
        itemKey: "PRIVATE_KEY",
        error: "PRIVATE_ERROR",
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
  it("keeps known model choices useful while suppressing custom model text", () => {
    expect(modelKey("gpt-5-codex")).toBe("gpt-5.4");
    expect(modelKey("claude-opus-4-6-20251117")).toBe("claude-opus-4-6");
    expect(modelKey("private-lab-model-alpha")).toBe("other");

    const normalized = normalizeInheritedEvent(
      "provider.turn.sent",
      { provider: "opencode", model: "private-lab-model-alpha" },
      context,
    );
    expect(normalized?.properties.modelKey).toBe("other");
    expect(JSON.stringify(normalized)).not.toContain("private-lab-model-alpha");
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

  it("rejects unregistered names and drops unregistered properties", () => {
    expect(normalizeInheritedEvent("ui.clicked", { selector: "#private" }, context)).toBeNull();
    const surface = normalizeInheritedEvent(
      "surface.opened",
      { surface: "settings", path: "/Users/private" },
      context,
    );
    expect(surface?.properties).toEqual({
      surface: "settings",
      ...context,
      contractRevision: ANALYTICS_CONTRACT_REVISION,
    });
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
    const unknown = normalizeInheritedEvent(
      "provider.turn.completed",
      { provider: "codex", terminalStatus: "completed", createdBy: "someone" },
      context,
    );
    expect(unknown?.properties).not.toHaveProperty("createdBy");
  });

  it("records client and feature events without device or free-text details", () => {
    const turn = normalizeInheritedEvent(
      "client.turn.requested",
      {
        surface: "desktop",
        clientDeviceType: "desktop",
        clientOs: "macOS",
        connectionMethod: "direct",
        clientBrowser: "PRIVATE",
        deviceModel: "PRIVATE",
        appVersion: "9.9.9-private",
      },
      context,
    );
    expect(turn?.properties).toEqual({
      surface: "desktop",
      clientDeviceType: "desktop",
      clientOs: "macOS",
      connectionMethod: "direct",
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
        callerModel: "private-custom-model",
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
      callerModel: "other",
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
