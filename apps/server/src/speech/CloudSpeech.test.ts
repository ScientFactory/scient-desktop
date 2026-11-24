import { it } from "@effect/vitest";
import { DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS, SecretProviderId } from "@t3tools/contracts";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { expect, vi } from "vite-plus/test";
import * as ServerSettings from "../serverSettings.ts";
import * as CloudSpeech from "./CloudSpeech.ts";
import * as LegacySpeechKeys from "./LegacySpeechKeys.ts";
import { AccountsService } from "../scient/accounts/AccountsService.ts";
import { makeHarness } from "../scient/accounts/Accounts.testkit.ts";

it.effect.each(["openai", "xai"] as const)("sends only to %s using its own saved key", (provider) =>
  Effect.gen(function* () {
    const reference = {
      provider: SecretProviderId.make("work"),
      reference: "op://Work/Voice/key",
    };
    let resolved: string | undefined;
    let cached: string | undefined;
    const read = vi.fn(() => Effect.sync(() => [(cached ??= resolved)]));
    const upstream = vi.fn<typeof fetch>(async () => Response.json({ text: "hello word alias" }));
    const service = yield* CloudSpeech.CloudSpeech.pipe(
      Effect.provide(
        CloudSpeech.layer.pipe(
          Layer.provide(FetchHttpClient.layer),
          Layer.provide(
            ServerSettings.ServerSettingsService.layerTest({
              transcriptionWords: [
                { term: "Canonical", variants: ["word alias"], language: "en", source: "user" },
                { term: "Excluded", language: "fr", source: "user" },
              ],
            }),
          ),
          Layer.provide(
            Layer.mock(SecretResolver.SecretResolver)({
              read,
              label: () => Effect.succeed("Work"),
              invalidate: () =>
                Effect.sync(() => {
                  cached = undefined;
                }),
            }),
          ),
        ),
      ),
    );
    const words = Array.from({ length: 14 }, (_, index) => `word${index}`);
    const transcribe = (pcm = new Uint8Array(new Float32Array([0, 0.5]).buffer)) =>
      service
        .transcribe(provider, pcm, {
          ...DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS,
          speechLanguage: "en",
          speechHints: ["Server", "T3 Code", ...words],
        })
        .pipe(Effect.provideService(FetchHttpClient.Fetch, upstream));
    yield* service.setKey(provider === "openai" ? "xai" : "openai", Redacted.make("other"));
    expect((yield* Effect.flip(transcribe()))._tag).toBe("CloudSpeechError");
    yield* service.setKey(provider, Redacted.make("chosen"));
    expect(yield* service.configured).toEqual({ openai: true, xai: true, openrouter: false });
    yield* Effect.flip(transcribe(new Uint8Array(3)));
    expect(upstream).not.toHaveBeenCalled();
    expect(yield* transcribe()).toBe("hello Canonical");
    const [url, init] = upstream.mock.calls[0]!;
    expect(String(url)).toBe(
      {
        openai: "https://api.openai.com/v1/audio/transcriptions",
        xai: "https://api.x.ai/v1/stt",
      }[provider],
    );
    expect(init?.redirect).toBe("error");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer chosen");
    const form = init?.body as FormData;
    expect(form.get("model")).toBe(
      provider === "openai" ? "gpt-transcribe" : "grok-voice-transcribe-2.0",
    );
    expect(form.getAll(provider === "openai" ? "keywords[]" : "keyterm")).toEqual([
      "Canonical",
      "Server",
      "T3 Code",
      ...words.slice(0, 13),
    ]);
    expect(form.get(provider === "openai" ? "languages[]" : "language")).toBe("en");
    expect([...form.keys()].at(-1)).toBe("file");
    const wav = new DataView(yield* Effect.promise(() => (form.get("file") as Blob).arrayBuffer()));
    expect(wav.getUint32(24, true)).toBe(16_000);
    expect(wav.getInt16(46, true)).toBe(16384);
    upstream.mockResolvedValueOnce(new Response("sensitive upstream diagnostic", { status: 401 }));
    expect(yield* Effect.flip(transcribe())).toMatchObject({ provider, reason: "rejected-key" });
    yield* service.setKey(provider, null);
    expect((yield* service.configured)[provider]).toBe(false);
    yield* Effect.flip(transcribe());
    expect(upstream).toHaveBeenCalledTimes(2);
    yield* service.setKey(provider, reference);
    expect((yield* service.configured)[provider]).toBe(true);
    expect(read).not.toHaveBeenCalled();
    resolved = "resolved-fixture";
    expect(yield* transcribe()).toBe("hello Canonical");
    expect(read).toHaveBeenCalledWith([reference]);
    expect(new Headers(upstream.mock.calls[2]?.[1]?.headers).get("authorization")).toBe(
      "Bearer resolved-fixture",
    );
    resolved = undefined;
    expect(yield* Effect.flip(transcribe())).toMatchObject({
      provider,
      reason: "unreadable-key",
    });
    expect(upstream).toHaveBeenCalledTimes(3);
  }),
);

it.effect("uploads to OpenRouter only for a listed exact model, as zero-retention JSON WAV", () =>
  Effect.gen(function* () {
    const upstream = vi.fn<typeof fetch>(async (input) =>
      new URL(String(input)).pathname.endsWith("/models")
        ? Response.json({ data: [{ id: "acme/transcribe-1" }, { id: "acme/transcribe-2" }] })
        : Response.json({ text: "hello" }),
    );
    const service = yield* CloudSpeech.CloudSpeech.pipe(
      Effect.provide(
        CloudSpeech.layer.pipe(
          Layer.provide(FetchHttpClient.layer),
          Layer.provide(ServerSettings.ServerSettingsService.layerTest()),
          Layer.provide(Layer.mock(SecretResolver.SecretResolver)({})),
        ),
      ),
    );
    const uploads = () =>
      upstream.mock.calls.filter(([url]) => String(url).endsWith("/audio/transcriptions"));
    const transcribe = (model: string | undefined) =>
      service
        .transcribe(
          "openrouter",
          new Uint8Array(new Float32Array([0, 0.5]).buffer),
          { ...DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS, speechLanguage: "en" },
          model,
        )
        .pipe(Effect.provideService(FetchHttpClient.Fetch, upstream));
    yield* service.setKey("openrouter", Redacted.make("router-key"));
    expect(yield* Effect.flip(transcribe(undefined))).toMatchObject({ provider: "openrouter" });
    upstream.mockResolvedValueOnce(new Response(null, { status: 503 }));
    expect(yield* Effect.flip(transcribe("acme/transcribe-2"))).toMatchObject({
      reason: "unavailable",
    });
    expect(yield* Effect.flip(transcribe("acme/delisted"))).toMatchObject({
      provider: "openrouter",
    });
    expect(uploads()).toEqual([]);
    expect(yield* transcribe("acme/transcribe-2")).toBe("hello");
    const [[url, init]] = uploads() as [[URL, RequestInit]];
    expect(new URL(String(upstream.mock.calls[0]![0])).searchParams.get("zdr")).toBe("true");
    expect(String(url)).toBe("https://openrouter.ai/api/v1/audio/transcriptions");
    expect(init.redirect).toBe("error");
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe("Bearer router-key");
    expect(headers.get("content-type")).toContain("application/json");
    const body = JSON.parse(yield* Effect.promise(() => new Response(init.body).text())) as {
      model: string;
      models?: unknown;
      provider: { zdr: boolean };
      input_audio: { format: string; data: string };
    };
    expect(body).toMatchObject({
      model: "acme/transcribe-2",
      provider: { zdr: true },
      input_audio: { format: "wav" },
    });
    expect(body.models).toBeUndefined();
    const wav = Buffer.from(body.input_audio.data, "base64");
    expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
    expect(wav.readInt16LE(46)).toBe(16384);
  }),
);

it.effect.each(["remove", "replace"] as const)(
  "blocks an Accounts-backed upload when Set Key will %s the key during catalog lookup",
  (change) =>
    Effect.gen(function* () {
      const { service: accounts } = yield* makeHarness();
      const resolveSpeechKey = vi.fn(accounts.resolveSpeechKey);
      const service = yield* CloudSpeech.CloudSpeech.pipe(
        Effect.provide(
          CloudSpeech.layer.pipe(
            Layer.provide(LegacySpeechKeys.layer),
            Layer.provide(Layer.succeed(AccountsService, { ...accounts, resolveSpeechKey })),
            Layer.provide(FetchHttpClient.layer),
            Layer.provide(
              ServerSettings.ServerSettingsService.layerTest({
                cloudSpeechCredentials: { openrouter: "synthetic-old-key" },
              }),
            ),
            Layer.provide(Layer.mock(SecretResolver.SecretResolver)({})),
          ),
        ),
      );
      expect((yield* service.configured).openrouter).toBe(true);
      expect(resolveSpeechKey).not.toHaveBeenCalled();
      expect((yield* accounts.snapshot).accounts).toHaveLength(0);
      const catalogStarted = Promise.withResolvers<void>();
      const catalog = Promise.withResolvers<Response>();
      const uploads = vi.fn<(_init: RequestInit | undefined) => Response>(() =>
        Response.json({ text: "uploaded" }),
      );
      const upstream: typeof fetch = async (input, init) => {
        if (new URL(String(input)).pathname.endsWith("/models")) {
          catalogStarted.resolve();
          return catalog.promise;
        }
        return uploads(init);
      };
      const transcribe = service
        .transcribe(
          "openrouter",
          new Uint8Array(4),
          DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS,
          "acme/voice",
        )
        .pipe(Effect.provideService(FetchHttpClient.Fetch, upstream));
      const job = yield* transcribe.pipe(Effect.forkChild);
      yield* Effect.promise(() => catalogStarted.promise);
      const before = (yield* accounts.snapshot).accounts;
      expect(before).toHaveLength(1);
      resolveSpeechKey.mockClear();
      expect((yield* service.configured).openrouter).toBe(true);
      expect(resolveSpeechKey).not.toHaveBeenCalled();
      yield* service.setKey(
        "openrouter",
        change === "replace" ? Redacted.make("synthetic-new-key") : null,
      );
      catalog.resolve(Response.json({ data: [{ id: "acme/voice" }] }));
      expect(Exit.findErrorOption(yield* Fiber.await(job))).toMatchObject({
        value: { reason: change === "replace" ? "key-changed" : "missing-key" },
      });
      expect(uploads).not.toHaveBeenCalled();
      if (change === "replace") {
        expect((yield* accounts.snapshot).accounts.map(({ accountId }) => accountId)).toEqual(
          before.map(({ accountId }) => accountId),
        );
        expect(yield* transcribe).toBe("uploaded");
        expect(new Headers(uploads.mock.lastCall?.[0]?.headers).get("authorization")).toBe(
          "Bearer synthetic-new-key",
        );
      } else {
        expect((yield* service.configured).openrouter).toBe(false);
        expect(yield* Effect.flip(transcribe)).toMatchObject({ reason: "missing-key" });
      }
    }),
);
