import { it } from "@effect/vitest";
import { ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { expect } from "vite-plus/test";

import { makeHarness } from "./Accounts.testkit.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import {
  keepTypedGeneratorKeys,
  keptGeneratorKey,
  readTextGeneratorKey,
} from "./textGeneratorKeys.ts";

it.effect(
  "reads the chosen key fresh, only for an endpoint it serves and a key for every project",
  () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      const key = (value: string, accountId?: Parameters<typeof service.save>[0]["accountId"]) =>
        service.save({
          ...(accountId ? { accountId } : {}),
          name: "OpenRouter",
          details: { kind: "api-key", sites: ["openrouter.ai"], auth: { type: "bearer" } },
          secrets: { token: { type: "scient", value } },
        });
      const { accountId } = yield* key("first-key");
      yield* service.setControls({ target: { type: "account", accountId }, access: "off" });
      const generator = {
        id: ProviderInstanceId.make("titles"),
        kind: "openaiCompatible" as const,
        baseUrl: "https://openrouter.ai/api/v1",
      };

      expect(yield* readTextGeneratorKey(service, accountId, generator)).toBe("first-key");
      yield* key("rotated-key", accountId);
      expect(yield* readTextGeneratorKey(service, accountId, generator)).toBe("rotated-key");
      const elsewhere = yield* readTextGeneratorKey(service, accountId, {
        ...generator,
        baseUrl: "https://example.com/v1",
      }).pipe(Effect.flip);
      expect(elsewhere).toContain("unavailable");
      // A generator writes for every project, so a key kept to one project doesn't fit it.
      yield* service.setControls({
        target: { type: "account", accountId },
        scope: { type: "projects", projectIds: [ProjectId.make("work")] },
      });
      const scoped = yield* readTextGeneratorKey(service, accountId, generator).pipe(Effect.flip);
      expect(scoped).toContain("unavailable");
      // A key too short to scrub from an error is never sent.
      yield* service.setControls({
        target: { type: "account", accountId },
        scope: { type: "all-projects" },
      });
      yield* key("short", accountId);
      expect(
        yield* readTextGeneratorKey(service, accountId, generator).pipe(Effect.flip),
      ).toContain("unavailable");
    }),
);

it.effect(
  "keeps a typed generator key in a row for it, leaving the typed value for older builds",
  () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      const id = ProviderInstanceId.make("titles");
      const generator = {
        kind: "openaiCompatible" as const,
        baseUrl: "https://openrouter.ai/api/v1",
        apiKey: "sk-synthetic-typed-key",
      };
      const use = { ...generator, id };
      yield* Effect.gen(function* () {
        const settings = yield* ServerSettingsService;
        yield* keepTypedGeneratorKeys(service, settings);
        // Settings still hold the typed key, which an older build reads.
        expect((yield* settings.getSettings).textGenerators[id]?.apiKey).toBe(generator.apiKey);
        const kept = (yield* service.snapshot).accounts[0]!;
        expect(kept.details).toMatchObject({ privateTo: { kind: "text-generator", id } });
        // A key replaced in Accounts reaches the generator while its typed value is unchanged.
        yield* service.save({
          accountId: kept.accountId,
          name: kept.name,
          details: kept.details,
          secrets: { token: { type: "scient", value: "sk-rotated-in-accounts" } },
        });
        expect((yield* keptGeneratorKey(service, use, generator.apiKey)).key).toBe(
          "sk-rotated-in-accounts",
        );
        // A typed value changed since, as by an older build, is the generator's own again.
        expect((yield* keptGeneratorKey(service, use, "sk-typed-later")).key).toBe(
          "sk-typed-later",
        );
        const scope = { threadId: ThreadId.make("t"), projectId: undefined, unattended: false };
        expect((yield* service.forSession(scope)).accounts).toEqual([]);
      }).pipe(
        Effect.provide(ServerSettingsService.layerTest({ textGenerators: { [id]: generator } })),
      );
    }),
);

it.effect(
  "never sends a generator's typed copy once its kept key is removed or can't be read",
  () =>
    Effect.gen(function* () {
      const { service, blobs } = yield* makeHarness();
      const id = ProviderInstanceId.make("titles");
      const generator = {
        kind: "openaiCompatible" as const,
        baseUrl: "https://openrouter.ai/api/v1",
        apiKey: "sk-synthetic-typed-key",
      };
      const use = { ...generator, id };
      yield* Effect.gen(function* () {
        const settings = yield* ServerSettingsService;
        yield* keepTypedGeneratorKeys(service, settings);
        const { accountId } = (yield* service.snapshot).accounts[0]!;
        // A kept row whose value can't be read fails rather than sending the typed copy.
        const values = [...blobs.keys()].filter((name) => name.startsWith("accounts-value-"));
        for (const name of values) blobs.delete(name);
        yield* Effect.flip(keptGeneratorKey(service, use, generator.apiKey));
        // The same key typed for another endpoint is the generator's own until it is kept.
        const moved = { ...use, baseUrl: "https://example.com/v1" };
        expect((yield* keptGeneratorKey(service, moved, generator.apiKey)).key).toBe(
          generator.apiKey,
        );
        yield* service.remove(accountId);
        // Settings still hold the typed value, as when the write after Remove never landed.
        expect(yield* Effect.flip(keptGeneratorKey(service, use, generator.apiKey))).toContain(
          "removed",
        );
        yield* keepTypedGeneratorKeys(service, settings);
        expect((yield* service.snapshot).accounts).toEqual([]);
        expect((yield* settings.getSettings).textGenerators[id]?.apiKey).toBe("");
      }).pipe(
        Effect.provide(ServerSettingsService.layerTest({ textGenerators: { [id]: generator } })),
      );
    }),
);

it.effect("never sends a typed https key too short to scrub from an error", () =>
  Effect.gen(function* () {
    const { service } = yield* makeHarness();
    const use = {
      id: ProviderInstanceId.make("titles"),
      kind: "openaiCompatible" as const,
      baseUrl: "https://openrouter.ai/api/v1",
    };
    yield* Effect.flip(keptGeneratorKey(service, use, "abc"));
    // A local endpoint's placeholder key is no secret and goes as typed.
    const local = { ...use, baseUrl: "http://127.0.0.1:11434/v1" };
    expect((yield* keptGeneratorKey(service, local, "ollama")).key).toBe("ollama");
  }),
);
