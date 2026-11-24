import { ScientServerSettings } from "../scientServerSettings.ts";
import * as LegacySpeechKeys from "../speech/LegacySpeechKeys.ts";
import * as Redacted from "effect/Redacted";
import { ServerSettingsService } from "../serverSettings.ts";
import { dispatchDictation } from "../speech/dictation.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  AuthFilesystemReadScope,
  AuthFilesystemWriteScope,
  AuthOrchestrationOperateScope,
  AuthSettingsWriteScope,
  AuthProvidersManageScope,
  ProjectId,
  type AuthEnvironmentScope,
  DEFAULT_SERVER_SETTINGS,
  SecretProviderId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { vi } from "vite-plus/test";
import { ServerConfig } from "../config.ts";
import { makeHarness } from "../scient/accounts/Accounts.testkit.ts";
import { AccountsService } from "../scient/accounts/AccountsService.ts";
import * as Cloud from "./CloudEngines.ts";
import * as Layer from "effect/Layer";
import { Etag, HttpPlatform, HttpRouter } from "effect/http";
import * as Auth from "../auth/EnvironmentAuth.ts";
import * as Jobs from "./TranscriptionJobs.ts";
import * as Http from "./http.ts";

const grants = [AuthFilesystemReadScope, AuthFilesystemWriteScope, AuthOrchestrationOperateScope];
const body = JSON.stringify({ action: "list", project: "/project" });
const post = (scopes: readonly AuthEnvironmentScope[] | undefined, payload: string) => {
  const routes = Http.layer.pipe(
    Layer.provide(
      Layer.mock(Auth.EnvironmentAuth)({
        authenticateHttpRequest: () =>
          scopes
            ? Effect.succeed({ subject: "test", scopes } as never)
            : Effect.fail({ _tag: "ServerAuthMissingCredentialError" } as never),
      }),
    ),
    Layer.provide(
      Layer.mock(Jobs.TranscriptionJobs)({
        enqueue: () => Effect.succeed({ queued: 2 }),
        execute: () =>
          Effect.fail(new Jobs.TranscriptionError({ code: "not-found", detail: "Missing." })),
      }),
    ),
    Layer.provideMerge(HttpPlatform.layer.pipe(Layer.provideMerge(Etag.layerWeak))),
    Layer.provide(NodeServices.layer),
  );
  return Effect.acquireUseRelease(
    Effect.sync(() => HttpRouter.toWebHandler(routes, { disableLogger: true })),
    ({ handler }) =>
      Effect.promise(() =>
        handler(
          new Request("http://localhost/api/transcription/jobs", {
            method: "POST",
            body: payload,
            headers: { authorization: "DPoP test", "content-type": "application/json" },
          }),
        ),
      ),
    ({ dispose }) => Effect.promise(() => dispose()),
  );
};

it.effect("challenges unauthenticated DPoP requests, checks all grants and maps job errors", () =>
  Effect.gen(function* () {
    const unauthorized = yield* post(undefined, body);
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get("www-authenticate")).toBe("DPoP");
    for (const missing of grants)
      expect(
        (yield* post(
          grants.filter((grant) => grant !== missing),
          body,
        )).status,
      ).toBe(403);
    expect((yield* post(grants, "{}")).status).toBe(400);
    expect((yield* post(grants, " ".repeat(32 * 1024) + body)).status).toBe(400);
    expect((yield* post(grants, body)).status).toBe(404);
  }),
);

it.effect("requires transcription grants to read inventory and revision content", () =>
  Effect.gen(function* () {
    for (const request of [
      { action: "inventory", project: "/project" },
      { action: "revision", project: "/project", id: "2026-11-22-lecture-12345678" },
    ]) {
      const payload = JSON.stringify(request);
      expect((yield* post(undefined, payload)).status).toBe(401);
      expect((yield* post([AuthFilesystemReadScope], payload)).status).toBe(403);
      expect((yield* post(grants, payload)).status).toBe(404);
    }
  }),
);

it.effect("applies the same grants to batch transcription admission", () =>
  Effect.gen(function* () {
    const payload = JSON.stringify({
      action: "start-batch",
      project: "/project",
      source: "/project/a.wav",
      sources: ["/project/a.wav", "/project/b.wav"],
      engine: "local",
      model: "whisper",
      language: "auto",
    });
    expect((yield* post([AuthFilesystemReadScope], payload)).status).toBe(403);
    const response = yield* post(grants, payload);
    expect(response.status).toBe(200);
    expect(yield* Effect.promise(() => response.json())).toEqual({ queued: 2 });
  }),
);

it.live(
  "protects engine configuration with settings grants and returns only binding metadata",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const stateDir = yield* fs.makeTempDirectoryScoped();
      const { service: accounts } = yield* makeHarness();
      const key = "synthetic-transcription-http-key";
      const { accountId } = yield* accounts.save({
        name: "Cloud account",
        details: {
          kind: "api-key",
          sites: ["https://api.openai.com"],
          auth: { type: "bearer" },
          speechOnly: true,
        },
        secrets: { token: { type: "scient", value: key } },
      });

      const outbound = vi.fn<typeof fetch>().mockImplementation(async (_, init) => {
        expect(new Headers(init?.headers).get("authorization") === "Bearer " + key).toBe(true);
        return Response.json({ text: key });
      });
      yield* Effect.acquireRelease(
        Effect.sync(() => vi.stubGlobal("fetch", outbound)),
        () => Effect.sync(() => vi.unstubAllGlobals()),
      );

      const settingsGrants = [AuthSettingsWriteScope, AuthProvidersManageScope];
      const engines = Cloud.layer.pipe(
        Layer.provide(Layer.succeed(AccountsService, accounts)),
        Layer.provide(
          Layer.mock(ScientServerSettings)({
            committedCustomModels: () => DEFAULT_SERVER_SETTINGS.customModels,
          }),
        ),
        Layer.provide(
          Layer.mock(ServerSettingsService)({
            getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
          }),
        ),
        Layer.provide(ServerConfig.layerTest(stateDir, stateDir)),
        Layer.provide(NodeServices.layer),
      );
      const routes = Http.enginesLayer.pipe(
        Layer.provide(engines),
        Layer.provide(
          Layer.mock(Auth.EnvironmentAuth)({
            authenticateHttpRequest: (request) =>
              Effect.succeed({
                subject: "test",
                scopes: request.headers.authorization === "DPoP owner" ? settingsGrants : grants,
              } as never),
          }),
        ),
        Layer.provideMerge(HttpPlatform.layer.pipe(Layer.provideMerge(Etag.layerWeak))),
        Layer.provide(NodeServices.layer),
      );
      const { handler } = yield* Effect.acquireRelease(
        Effect.sync(() => HttpRouter.toWebHandler(routes, { disableLogger: true })),
        ({ dispose }) => Effect.promise(() => dispose()),
      );
      const command = (body: object, authorization = "DPoP owner") =>
        Effect.promise(async () => {
          const response = await handler(
            new Request("http://localhost/api/transcription/engines", {
              method: "POST",
              body: JSON.stringify(body),
              headers: { authorization, "content-type": "application/json" },
            }),
          );
          const text = await response.text();
          expect(text.includes(key)).toBe(false);
          return { status: response.status, body: JSON.parse(text) };
        });
      expect((yield* command({ action: "list" }, "DPoP guest")).status).toBe(403);
      const options = {
        accountId,
        provider: "openai",
        model: "gpt-transcribe",
        maxAudioBytes: 100_000,
      };
      const added = yield* command({ action: "add", ...options });
      expect(added.status).toBe(200);
      const id = added.body.id;
      const description = yield* Effect.flatMap(Cloud.CloudEngines, (service) =>
        service.describe
          ? service.describe(added.body)
          : Effect.die("Expected cloud engine metadata"),
      ).pipe(Effect.provide(engines));
      expect(description).toEqual({
        accountName: "Cloud account",
        origin: "https://api.openai.com",
      });
      expect(outbound).not.toHaveBeenCalled();
      const resolve = Effect.flatMap(Cloud.CloudEngines, (service) => service.resolve(id)).pipe(
        Effect.provide(engines),
      );
      const wav = Buffer.alloc(48);
      wav.write("RIFF", 0);
      wav.writeUInt32LE(40, 4);
      wav.write("WAVEfmt ", 8);
      wav.writeUInt32LE(16, 16);
      wav.writeUInt16LE(1, 20);
      wav.writeUInt16LE(1, 22);
      wav.writeUInt32LE(24_000, 24);
      wav.writeUInt32LE(48_000, 28);
      wav.writeUInt16LE(2, 32);
      wav.writeUInt16LE(16, 34);
      wav.write("data", 36);
      wav.writeUInt32LE(4, 40);
      const dictate = Effect.flatMap(Cloud.CloudEngines, (cloud) =>
        dispatchDictation(
          {
            cloud,
            speech: undefined,
            providerInstances: { getInstance: () => Effect.undefined },
          },
          { audioBase64: wav.toString("base64"), selection: { kind: "cloud", engineId: id } },
        ),
      ).pipe(Effect.provide(engines));
      expect(yield* dictate.pipe(Effect.flip)).toMatchObject({ reason: "consent-required" });
      expect(yield* resolve.pipe(Effect.flip)).toMatchObject({ code: "consent-required" });
      expect((yield* command({ action: "list" })).body).toEqual([{ ...options, id }]);
      expect((yield* command({ action: "test", id })).body).toEqual({ ok: true });
      expect(outbound).toHaveBeenCalledTimes(1);
      outbound.mockResolvedValueOnce(new Response(key, { status: 401 }));
      expect((yield* command({ action: "test", id })).body.code).toBe("provider-key-rejected");
      expect(
        (yield* command({
          action: "add",
          ...options,
          provider: "compatible",
          baseUrl: "http://localhost:55001/v1",
        })).status,
      ).toBe(400);
      expect(
        (yield* command({ action: "set-upload-consent", id, allowed: true }, "DPoP guest")).status,
      ).toBe(403);
      expect(
        (yield* command({ action: "set-upload-consent", id, allowed: true })).body.uploadConsent,
      ).toBe(true);
      outbound.mockResolvedValueOnce(Response.json({ text: "consented dictation" }));
      expect(yield* dictate).toEqual({ text: "consented dictation" });
      outbound.mockResolvedValueOnce(new Response(null, { status: 401 }));
      expect(yield* dictate.pipe(Effect.flip)).toMatchObject({ reason: "key-rejected" });
      const bound = yield* resolve;
      expect(bound.origin).toBe("https://api.openai.com");
      expect(
        (yield* command({ action: "set-upload-consent", id, allowed: false })).body.uploadConsent,
      ).toBe(false);
      const revoked = yield* Effect.tryPromise({
        try: (signal) =>
          bound.open("auto", signal, "revoked-job").recognize(new Float32Array(16_000), false),
        catch: () => "revoked" as const,
      }).pipe(Effect.flip);
      expect(revoked).toBe("revoked");
      expect(yield* dictate.pipe(Effect.flip)).toMatchObject({ reason: "consent-required" });
      expect(outbound).toHaveBeenCalledTimes(4);
      yield* command({ action: "set-upload-consent", id, allowed: true });
      expect(
        (yield* command({ action: "update", ...options, id, maxAudioBytes: 50_000 })).body
          .maxAudioBytes,
      ).toBe(50_000);
      expect((yield* command({ action: "list" })).body[0].uploadConsent).toBeUndefined();
      const projectId = ProjectId.make("project-intended");
      const scopedAccount = (yield* accounts.snapshot).accounts.find(
        (row) => row.accountId === accountId,
      )!;
      yield* accounts.save({
        accountId,
        name: scopedAccount.name,
        details: scopedAccount.details,
        controls: {
          ...scopedAccount.controls,
          scope: { type: "projects", projectIds: [projectId] },
        },
        secrets: {},
      });
      const denied = {
        code: "key-not-available-in-project",
        message: "The key is not available in this project.",
      };
      expect((yield* command({ action: "add", ...options })).body).toEqual(denied);
      expect(
        (yield* command({ action: "update", id, ...options, projectId: "other-project" })).body,
      ).toEqual(denied);
      expect((yield* command({ action: "test", id })).body).toEqual(denied);
      expect((yield* command({ action: "add", ...options, projectId })).status).toBe(200);
      const updated = yield* command({ action: "update", id, ...options, projectId });
      expect(updated.status).toBe(200);
      expect(updated.body).not.toHaveProperty("projectId");
      expect((yield* command({ action: "test", id, projectId })).body).toEqual({ ok: true });
      expect((yield* command({ action: "remove", id })).body).toEqual({ ok: true });
      expect((yield* command({ action: "test", id })).status).toBe(404);
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.live("migrates origin-bound keys once and keeps external references on the legacy path", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const stateDir = yield* fs.makeTempDirectoryScoped();
    const { service: accounts } = yield* makeHarness();
    const engines = Cloud.layer.pipe(
      Layer.provide(LegacySpeechKeys.layer),
      Layer.provide(Layer.succeed(AccountsService, accounts)),
      Layer.provide(
        Layer.mock(ScientServerSettings)({
          committedCustomModels: () => DEFAULT_SERVER_SETTINGS.customModels,
        }),
      ),
      Layer.provide(
        ServerSettingsService.layerTest({
          cloudSpeechCredentials: {
            openai: "synthetic-legacy-audio-key",
            xai: {
              provider: SecretProviderId.make("synthetic-vault"),
              reference: "op://Synthetic/Voice/token",
            },
          },
        }),
      ),
      Layer.provide(ServerConfig.layerTest(stateDir, stateDir)),
      Layer.provide(NodeServices.layer),
    );
    yield* Effect.gen(function* () {
      const service = yield* Cloud.CloudEngines;
      const first = yield* service.listDictationChoices;
      expect(first).toMatchObject([
        {
          id: expect.any(String),
          model: "gpt-transcribe",
          origin: "https://api.openai.com",
          migrated: true,
        },
      ]);
      expect(yield* service.listDictationChoices).toEqual(first);
      const snapshot = yield* accounts.snapshot;
      expect(snapshot.accounts).toHaveLength(1);
      expect(snapshot.accounts[0]?.details).toMatchObject({
        kind: "api-key",
        sites: ["https://api.openai.com"],
        speechOnly: true,
      });
      const id = first[0]!.id;
      expect((yield* Effect.flip(service.resolve(id))).code).toBe("consent-required");
      yield* service.chooseForDictation(first[0]!);
      expect((yield* service.resolve(id)).origin).toBe("https://api.openai.com");
      yield* service.execute({ action: "remove", id });
      yield* accounts.remove(snapshot.accounts[0]!.accountId);
      expect(yield* service.listDictationChoices).toEqual([]);
      expect((yield* accounts.snapshot).accounts).toHaveLength(0);
    }).pipe(Effect.provide(engines));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.live("uses the saved Custom models binding by reference and reconnects after removal", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped();
    const { service: accounts } = yield* makeHarness();
    const connection = {
      id: "fixture-openai",
      name: "OpenAI",
      baseUrl: "https://api.openai.com/v1",
      protocol: "openai-completions" as const,
      models: [],
      credentialId: "fixture-credential",
    };
    let connected = true;
    const key = "synthetic-reused-speech-key";
    const engines = Cloud.layer.pipe(
      Layer.provide(Layer.succeed(AccountsService, accounts)),
      Layer.provide(
        Layer.mock(ScientServerSettings)({
          committedCustomModels: () => ({
            revision: 0,
            connections: connected ? [connection] : [],
          }),
        }),
      ),
      Layer.provide(
        Layer.mock(ServerSettingsService)({
          getSettings: Effect.sync(() => ({
            ...DEFAULT_SERVER_SETTINGS,
            customModels: { revision: 0, connections: connected ? [connection] : [] },
          })),
          resolveSpeechCustomModelKey: (id, origin) =>
            Effect.succeed(
              connected && id === connection.id && origin === "https://api.openai.com"
                ? { name: connection.name, token: Redacted.make(key) }
                : undefined,
            ),
        }),
      ),
      Layer.provide(ServerConfig.layerTest(dir, dir)),
      Layer.provide(NodeServices.layer),
    );
    yield* Effect.gen(function* () {
      const service = yield* Cloud.CloudEngines;
      expect(yield* service.savedKeys("https://api.openai.com")).toEqual([
        {
          id: connection.id,
          kind: "custom-model",
          label: connection.name,
          origin: "https://api.openai.com",
        },
      ]);
      expect(yield* service.savedKeys("https://api.openai.com:444")).toEqual([]);
      const binding = {
        action: "add" as const,
        provider: "openai" as const,
        model: "gpt-transcribe",
        customModelConnectionId: connection.id,
        maxAudioBytes: 1_000_000,
      };
      expect(
        (yield* Effect.flip(
          service.execute({
            ...binding,
            provider: "compatible",
            baseUrl: "https://other.example/v1",
          }),
        )).code,
      ).toBe("unavailable");
      const added = yield* service.execute(binding);
      const [choice] = yield* service.listDictationChoices;
      expect(choice?.origin).toBe("https://api.openai.com");
      expect(JSON.stringify([added, choice])).not.toContain(key);
      expect((yield* accounts.snapshot).accounts).toHaveLength(0);
      yield* service.chooseForDictation(choice!);
      expect((yield* service.resolve(choice!.id)).origin).toBe(choice!.origin);
      connected = false;
      expect((yield* Effect.flip(service.resolve(choice!.id))).code).toBe("unavailable");
      expect((yield* service.listDictationChoices)[0]?.reconnect).toBe(true);
    }).pipe(Effect.provide(engines));
  }).pipe(Effect.provide(NodeServices.layer)),
);
