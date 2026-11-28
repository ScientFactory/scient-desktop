import { it } from "@effect/vitest";
import { AccountId, accountKeyReference, ProviderInstanceId } from "@t3tools/contracts";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { expect, vi } from "vite-plus/test";

import * as TextGeneratorKeys from "../scient/accounts/textGeneratorKeys.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGenerators from "./TextGenerators.ts";

const ID = ProviderInstanceId.make("router");

it.effect("a provider error that repeats the key does not pass it on", () =>
  Effect.gen(function* () {
    const key = "sk-synthetic-0123456789abcdef";
    const upstream = vi.fn<typeof fetch>(async () =>
      Response.json({ error: { message: `Invalid key ${key} for this org` } }, { status: 401 }),
    );
    const generators = yield* TextGenerators.TextGenerators.pipe(
      Effect.provide(
        Layer.effect(TextGenerators.TextGenerators, TextGenerators.make).pipe(
          Layer.provideMerge(
            ServerSettings.layerTest({
              textGenerators: {
                [ID]: { kind: "openaiCompatible", baseUrl: "https://api.test/v1", apiKey: key },
              },
            }),
          ),
          Layer.provide(FetchHttpClient.layer),
          Layer.provide(Layer.mock(SecretResolver.SecretResolver)({})),
        ),
      ),
    );
    const failure = yield* Effect.flip(
      generators
        .listModels({ id: ID, refresh: true })
        .pipe(Effect.provideService(FetchHttpClient.Fetch, upstream)),
    );
    expect(failure.detail).toContain("Invalid key [redacted] for this org");
    expect(failure.detail).not.toContain(key);
  }),
);

it.effect("lists models again when the generator's Accounts key was removed", () =>
  Effect.gen(function* () {
    let saved = true;
    const upstream = vi.fn<typeof fetch>(async () => Response.json({ data: [{ id: "m1" }] }));
    const program = Effect.gen(function* () {
      const keys = yield* TextGeneratorKeys.TextGeneratorKeys;
      yield* keys.serve({
        read: () => (saved ? Effect.succeed("sk-synthetic-key") : Effect.fail("gone")),
        report: () => Effect.void,
        kept: (_generator, typed) => Effect.succeed({ key: typed }),
      });
      const generators = yield* TextGenerators.TextGenerators;
      const list = generators
        .listModels({ id: ID })
        .pipe(Effect.provideService(FetchHttpClient.Fetch, upstream));
      expect((yield* list).models.map(({ id }) => id)).toEqual(["m1"]);
      saved = false;
      expect((yield* Effect.flip(list)).detail).toBe("gone");
    });
    yield* program.pipe(
      Effect.provide(
        Layer.effect(TextGenerators.TextGenerators, TextGenerators.make).pipe(
          Layer.provideMerge(TextGeneratorKeys.layer),
          Layer.provideMerge(
            ServerSettings.layerTest({
              textGenerators: {
                [ID]: {
                  kind: "openaiCompatible",
                  baseUrl: "https://api.test/v1",
                  apiKey: accountKeyReference(AccountId.make("acc_synthetic1")),
                },
              },
            }),
          ),
          Layer.provide(FetchHttpClient.layer),
          Layer.provide(Layer.mock(SecretResolver.SecretResolver)({})),
        ),
      ),
    );
  }),
);

it.effect("counts only a 401 as a refused key, and only a generation as working", () =>
  Effect.gen(function* () {
    const reports: Array<string> = [];
    const replies = [
      Response.json({ data: [{ id: "m1" }] }),
      Response.json({ error: { message: "model not allowed" } }, { status: 403 }),
      Response.json({ error: { message: "bad key" } }, { status: 401 }),
      Response.json({
        choices: [{ finish_reason: "stop", message: { content: '{"title":"T"}' } }],
      }),
    ];
    const upstream = vi.fn<typeof fetch>(async () => replies.shift()!);
    const program = Effect.gen(function* () {
      const keys = yield* TextGeneratorKeys.TextGeneratorKeys;
      yield* keys.serve({
        read: () => Effect.succeed("sk-synthetic-key"),
        report: (_generator, _sent, outcome) => Effect.sync(() => void reports.push(outcome)),
        kept: (_generator, typed) => Effect.succeed({ key: typed }),
      });
      const generators = yield* TextGenerators.TextGenerators;
      const fetchWith = Effect.provideService(FetchHttpClient.Fetch, upstream);
      yield* generators.listModels({ id: ID }).pipe(fetchWith);
      const run = (yield* generators.runner(ID))!;
      const request = {
        operation: "generateThreadTitle",
        cwd: "/unused",
        prompt: "Name this thread.",
        outputSchema: Schema.Struct({ title: Schema.String }),
        modelSelection: { instanceId: ID, model: "m1" },
      } as const;
      yield* Effect.exit(run(request).pipe(fetchWith));
      yield* Effect.exit(run(request).pipe(fetchWith));
      yield* run(request).pipe(fetchWith);
    });
    yield* program.pipe(
      Effect.provide(
        Layer.effect(TextGenerators.TextGenerators, TextGenerators.make).pipe(
          Layer.provideMerge(TextGeneratorKeys.layer),
          Layer.provideMerge(
            ServerSettings.layerTest({
              textGenerators: {
                [ID]: {
                  kind: "openaiCompatible",
                  baseUrl: "https://api.test/v1",
                  apiKey: accountKeyReference(AccountId.make("acc_synthetic1")),
                },
              },
            }),
          ),
          Layer.provide(FetchHttpClient.layer),
          Layer.provide(Layer.mock(SecretResolver.SecretResolver)({})),
        ),
      ),
    );
    expect(reports).toEqual(["refused", "ok"]);
  }),
);

it.effect("lists models again when a typed key's Accounts row was replaced", () =>
  Effect.gen(function* () {
    let row = "sk-synthetic-kept-1";
    const sent: Array<string | null> = [];
    const upstream = vi.fn<typeof fetch>(async (_url, init) => {
      sent.push(new Headers(init?.headers).get("authorization"));
      return Response.json({ data: [{ id: "m1" }] });
    });
    const program = Effect.gen(function* () {
      const keys = yield* TextGeneratorKeys.TextGeneratorKeys;
      yield* keys.serve({
        read: () => Effect.fail("unused"),
        report: () => Effect.void,
        kept: () => Effect.succeed({ key: row, accountId: AccountId.make("acc_use_synthetic") }),
      });
      const generators = yield* TextGenerators.TextGenerators;
      const list = generators
        .listModels({ id: ID })
        .pipe(Effect.provideService(FetchHttpClient.Fetch, upstream));
      yield* list;
      yield* list;
      row = "sk-synthetic-kept-2";
      yield* list;
      expect(sent).toEqual(["Bearer sk-synthetic-kept-1", "Bearer sk-synthetic-kept-2"]);
    });
    yield* program.pipe(
      Effect.provide(
        Layer.effect(TextGenerators.TextGenerators, TextGenerators.make).pipe(
          Layer.provideMerge(TextGeneratorKeys.layer),
          Layer.provideMerge(
            ServerSettings.layerTest({
              textGenerators: {
                [ID]: {
                  kind: "openaiCompatible",
                  baseUrl: "https://api.test/v1",
                  apiKey: "sk-synthetic-typed",
                },
              },
            }),
          ),
          Layer.provide(FetchHttpClient.layer),
          Layer.provide(Layer.mock(SecretResolver.SecretResolver)({})),
        ),
      ),
    );
  }),
);
