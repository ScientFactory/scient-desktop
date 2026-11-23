import { describe, expect, it } from "@effect/vitest";
import {
  ConnectorId,
  ProjectId,
  ThreadId,
  VaultSecretRef,
  defaultAccountControls,
} from "@t3tools/contracts";
import { Effect, Stream } from "effect";
import { accountTokenRef } from "./AccountBoundRef.ts";
import { makeHarness, secretEquals, syntheticValue, website } from "./Accounts.testkit.ts";

const consumer = {
  kind: "connector" as const,
  connectorId: ConnectorId.make("con_synthetic01"),
  origin: "https://api.example.com",
};
const apiKey = (value = syntheticValue()) => ({
  name: "Synthetic API",
  details: { kind: "api-key" as const, sites: ["example.com"], auth: { type: "bearer" as const } },
  secrets: { token: { type: "scient" as const, value } },
});

it.effect("resolves owner-configured model keys at the exact origin after replacement", () =>
  Effect.gen(function* () {
    const { service } = yield* makeHarness();
    const input = apiKey();
    const origin = "http://127.0.0.1:8080";
    const modelKey = {
      ...input,
      details: { ...input.details, sites: [origin], purpose: "custom-models" as const },
    };
    const { accountId } = yield* service.save(modelKey);
    const replacement = syntheticValue();
    yield* service.save({
      ...modelKey,
      accountId,
      secrets: { token: { type: "scient", value: replacement } },
    });
    yield* service.setAgentAccess(false);
    const resolved = yield* service.resolveCustomModelAccountKey(accountId, origin);
    expect(resolved.name).toBe(input.name);
    expect(secretEquals(resolved.token, replacement)).toBe(true);
    for (const otherOrigin of ["https://127.0.0.1:8080", "http://127.0.0.1:8081", origin + "/v1"]) {
      expect(
        (yield* service.resolveCustomModelAccountKey(accountId, otherOrigin).pipe(Effect.flip))
          .reason,
      ).toBe("denied");
    }
    yield* service.remove(accountId);
    expect(
      (yield* service.resolveCustomModelAccountKey(accountId, origin).pipe(Effect.flip)).reason,
    ).toBe("not-found");
  }),
);

describe("Accounts connector bindings", () => {
  it.effect("resolves current keys, records use, and never copies a binding value", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      const input = apiKey();
      const { accountId } = yield* service.save(input);
      const ref = accountTokenRef(accountId);
      yield* service.save(website());
      expect(yield* service.listBindable({ origin: consumer.origin })).toEqual([
        { ref, name: input.name },
      ]);
      expect(yield* service.listBindable({ origin: "https://example.net" })).toEqual([]);
      expect(
        secretEquals(yield* service.resolveBound(ref, consumer), input.secrets.token.value),
      ).toBe(true);
      const activity = yield* service.changes.pipe(
        Stream.filter((snapshot) => snapshot.recentActivity.length > 0),
        Stream.take(1),
        Stream.runCollect,
      );
      expect(activity[0]?.recentActivity[0]).toMatchObject({
        target: { type: "account", accountId },
        action: "request",
        decision: "allowed",
        detail: consumer.origin,
      });
      const replacement = syntheticValue();
      yield* service.save({
        ...input,
        accountId,
        secrets: { token: { type: "scient", value: replacement } },
      });
      expect(secretEquals(yield* service.resolveBound(ref, consumer), replacement)).toBe(true);
      yield* service.remove(accountId);
      expect((yield* service.resolveBound(ref, consumer).pipe(Effect.flip)).reason).toBe(
        "not-found",
      );
    }),
  );

  it.effect("rejects invalid refs, non-key accounts, missing tokens and mismatched origins", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      expect(
        (yield* service
          .resolveBound(VaultSecretRef.make("account:acc_invalid01:password"), consumer)
          .pipe(Effect.flip)).reason,
      ).toBe("invalid-input");
      const { accountId: websiteId } = yield* service.save(website());
      expect(
        (yield* service.resolveBound(accountTokenRef(websiteId), consumer).pipe(Effect.flip))
          .reason,
      ).toBe("denied");
      const { accountId } = yield* service.save(apiKey());
      const ref = accountTokenRef(accountId);
      expect(
        (yield* service
          .resolveBound(ref, { ...consumer, origin: "https://notexample.com" })
          .pipe(Effect.flip)).reason,
      ).toBe("denied");
      yield* service.save({ ...apiKey(), accountId, secrets: { token: { type: "clear" } } });
      expect((yield* service.resolveBound(ref, consumer).pipe(Effect.flip)).reason).toBe(
        "not-found",
      );
    }),
  );

  it.effect("treats a user binding as Ask approval while enforcing both Off switches", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      const input = apiKey();
      const { accountId } = yield* service.save({
        ...input,
        controls: { ...defaultAccountControls("api-key"), access: "ask" },
      });
      const ref = accountTokenRef(accountId);
      expect(
        secretEquals(yield* service.resolveBound(ref, consumer), input.secrets.token.value),
      ).toBe(true);
      expect((yield* service.snapshot).approvals).toEqual([]);
      yield* service.setControls({ target: { type: "account", accountId }, access: "off" });
      expect((yield* service.resolveBound(ref, consumer).pipe(Effect.flip)).reason).toBe("denied");
      yield* service.setControls({ target: { type: "account", accountId }, access: "allowed" });
      yield* service.setAgentAccess(false);
      expect((yield* service.resolveBound(ref, consumer).pipe(Effect.flip)).reason).toBe("denied");
    }),
  );

  it.effect(
    "offers every key to a plugin without a site and still enforces Off and project scope",
    () =>
      Effect.gen(function* () {
        const { service } = yield* makeHarness();
        const input = { ...apiKey(), details: { ...apiKey().details, sites: [] } };
        const { accountId } = yield* service.save({
          ...input,
          controls: { ...defaultAccountControls("api-key"), access: "ask" },
        });
        const ref = accountTokenRef(accountId);
        expect(yield* service.listBindable({})).toEqual([{ ref, name: input.name }]);
        expect(yield* service.listBindable({ origin: consumer.origin })).toEqual([]);
        const project = ProjectId.make("project-synthetic");
        const plugin = {
          kind: "plugin-key" as const,
          agent: "claudeAgent",
          pluginId: "terraform@synthetic",
          envName: "TFE_TOKEN",
          projectId: project,
        };
        expect(
          secretEquals(yield* service.resolveBound(ref, plugin), input.secrets.token.value),
        ).toBe(true);
        expect((yield* service.snapshot).approvals).toEqual([]);
        const activity = yield* service.changes.pipe(
          Stream.filter((snapshot) => snapshot.recentActivity.length > 0),
          Stream.take(1),
          Stream.runCollect,
        );
        expect(activity[0]?.recentActivity.at(-1)).toMatchObject({
          target: { type: "account", accountId },
          decision: "allowed",
          detail: "plugin terraform@synthetic TFE_TOKEN on claudeAgent",
          projectId: project,
        });
        yield* service.setControls({
          target: { type: "account", accountId },
          access: "ask",
          scope: { type: "projects", projectIds: [ProjectId.make("project-other")] },
        });
        expect((yield* service.resolveBound(ref, plugin).pipe(Effect.flip)).reason).toBe("denied");
        expect(
          (yield* service
            .resolveBound(ref, { ...plugin, projectId: ProjectId.make("project-x") })
            .pipe(Effect.flip)).reason,
        ).toBe("denied");
        yield* service.setControls({
          target: { type: "account", accountId },
          access: "off",
          scope: { type: "all-projects" },
        });
        expect((yield* service.resolveBound(ref, plugin).pipe(Effect.flip)).reason).toBe("denied");
      }),
  );
});

it.effect(
  "keeps a sealed speech account out of agent access and binds its key to the configured origin",
  () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      const input = apiKey();
      const origin = "http://127.0.0.1:54001";
      const { accountId } = yield* service.save({
        ...input,
        details: { ...input.details, sites: [origin], speechOnly: true },
      });
      const scope = {
        threadId: ThreadId.make("thread-synthetic"),
        projectId: ProjectId.make("project-synthetic"),
        unattended: false,
      };
      expect((yield* service.forSession(scope)).accounts).toEqual([]);
      expect(yield* service.listBindable({})).toEqual([]);
      expect((yield* service.resolveSecrets(accountId, ["token"]).pipe(Effect.flip)).reason).toBe(
        "not-found",
      );
      expect(
        (yield* service.resolveBound(accountTokenRef(accountId), consumer).pipe(Effect.flip))
          .reason,
      ).toBe("denied");
      expect(
        (yield* service.resolveSpeechKey(accountId, origin + "0").pipe(Effect.flip)).reason,
      ).toBe("denied");
      const jobId = "2026-11-22-recording-12345678";
      const { name, token } = yield* service.resolveSpeechKey(accountId, origin, {
        provider: "compatible",
        jobId,
      });
      const { recentActivity } = yield* service.snapshot;
      expect(recentActivity.at(-1)).toMatchObject({
        target: { type: "account", accountId },
        detail: "Speech compatible " + jobId,
        decision: "allowed",
      });
      expect(JSON.stringify(recentActivity).includes(input.secrets.token.value)).toBe(false);
      for (const site of [
        "example.com",
        "http://localhost:54001",
        "https://api.example.com/path",
      ]) {
        expect(
          (yield* service
            .save({
              ...input,
              details: { ...input.details, sites: [site], speechOnly: true },
            })
            .pipe(Effect.flip)).reason,
        ).toBe("invalid-input");
      }
      expect(
        (yield* service
          .save({
            ...input,
            details: { ...input.details, sites: [origin] },
          })
          .pipe(Effect.flip)).reason,
      ).toBe("invalid-input");
      const exact = yield* service.save({
        ...input,
        details: { ...input.details, sites: ["https://api.example.com"], speechOnly: true },
      });
      expect(
        (yield* service
          .resolveSpeechKey(exact.accountId, "https://child.api.example.com")
          .pipe(Effect.flip)).reason,
      ).toBe("denied");
      expect(name).toBe(input.name);
      expect(secretEquals(token, input.secrets.token.value)).toBe(true);
    }),
);

it.effect("defaults picker-created keys to agents off and applies project scope to speech", () =>
  Effect.gen(function* () {
    const { service } = yield* makeHarness();
    const origin = "https://api.example.test";
    const input = apiKey();
    const { accountId } = yield* service.save({
      ...input,
      details: { ...input.details, sites: [origin], purpose: "custom-models" },
    });
    expect((yield* service.snapshot).accounts[0]?.controls.access).toBe("off");
    expect(yield* service.listBindable({ origin })).toEqual([]);
    expect(
      (yield* service.forSession({
        projectId: ProjectId.make("project-scope"),
        threadId: ThreadId.make("thread-scope"),
        unattended: false,
      })).accounts,
    ).toEqual([]);
    const projectId = ProjectId.make("project-scope");
    yield* service.setControls({
      target: { type: "account", accountId },
      scope: { type: "projects", projectIds: [projectId] },
    });
    yield* service.setAgentAccess(false);
    const resolved = yield* service.resolveSpeechKey(accountId, origin, undefined, projectId);
    expect(secretEquals(resolved.token, input.secrets.token.value)).toBe(true);
    expect((yield* service.resolveSpeechKey(accountId, origin).pipe(Effect.flip)).reason).toBe(
      "denied",
    );
  }),
);
