import {
  KEEP_AWAKE_OBSERVE_PATH,
  KeepAwakeWorkBatch,
  PRIMARY_LOCAL_ENVIRONMENT_ID,
  ThreadId,
  type KeepAwakeDocument,
} from "@t3tools/contracts";
import { bootstrapRemoteBearerSession } from "@t3tools/client-runtime/authorization";
import { currentDesktopBootstrapToken } from "@t3tools/shared/desktopBootstrapToken";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { DesktopBackendPool } from "../../backend/DesktopBackendPool.ts";
import { DesktopSavedEnvironments } from "../../settings/DesktopSavedEnvironments.ts";

export interface WorkSourceResult {
  readonly local: boolean;
  readonly batch: KeepAwakeWorkBatch;
  readonly error?: string;
  readonly generation?: number;
}
export class KeepAwakeSourceError extends Schema.TaggedError<KeepAwakeSourceError>()(
  "KeepAwakeSourceError",
  { cause: Schema.Defect() },
) {}
export class KeepAwakeSource extends Context.Service<
  KeepAwakeSource,
  {
    readonly observe: (
      document: KeepAwakeDocument,
    ) => Effect.Effect<readonly WorkSourceResult[], KeepAwakeSourceError>;
  }
>()("@t3tools/desktop/scient/keepAwake/source/KeepAwakeSource") {}
const threadAddress = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Tuple([Schema.String, ThreadId])),
);
export const layer = Layer.effect(
  KeepAwakeSource,
  Effect.gen(function* () {
    const pool = yield* DesktopBackendPool;
    const saved = yield* DesktopSavedEnvironments;
    const http = yield* HttpClient.HttpClient;
    const tokens = new Map<string, string>();
    const identities = new Map<string, string>();
    let generation = 0;
    const fetchBatch = Effect.fn("KeepAwakeSource.fetchBatch")(function* (
      origin: string,
      token: string,
      ids: readonly ThreadId[],
      includeLocalWork: boolean,
      local = true,
    ) {
      const requestGeneration = ++generation;
      const request = yield* HttpClientRequest.post(new URL(KEEP_AWAKE_OBSERVE_PATH, origin)).pipe(
        HttpClientRequest.bearerToken(token),
        HttpClientRequest.bodyJson({ threadIds: ids, includeLocalWork }),
      );
      const response = yield* http.execute(request);
      if (response.status < 200 || response.status >= 300) {
        if (response.status === 401) tokens.delete(origin);
        return yield* new KeepAwakeSourceError({
          cause: `Work observation unavailable (HTTP ${response.status})`,
        });
      }
      const batch = yield* HttpClientResponse.schemaBodyJson(KeepAwakeWorkBatch)(response);
      identities.set(origin, batch.environmentId);
      return { local, batch, generation: requestGeneration };
    });
    return KeepAwakeSource.of({
      observe: Effect.fn("KeepAwakeSource.observe")(
        function* (document: KeepAwakeDocument) {
          const explicit = yield* Effect.forEach(
            document.threads.filter((thread) => thread.once || thread.startedAt !== null),
            (thread) => threadAddress(thread.key),
          );
          const results: WorkSourceResult[] = [];
          const attempt = <E, R>(
            work: Effect.Effect<WorkSourceResult, E, R>,
            local: boolean,
            environmentId: string,
          ) =>
            work.pipe(
              Effect.timeout("10 seconds"),
              Effect.catchCause(() =>
                Effect.succeed({
                  local,
                  batch: { environmentId, groups: [] },
                  error:
                    "Could not refresh an execution environment. Its protection will expire without fresh updates.",
                }),
              ),
            );
          const localIds = new Set<string>();
          const retainedOrigins = new Set<string>();
          const instances = yield* pool.list;
          results.push(
            ...(yield* Effect.forEach(
              instances,
              (instance) =>
                attempt(
                  Effect.gen(function* () {
                    const config = yield* instance.currentConfig;
                    if (Option.isNone(config) || !(yield* instance.snapshot).ready)
                      return { local: true, batch: { environmentId: "", groups: [] } };
                    const origin = config.value.httpBaseUrl.href;
                    retainedOrigins.add(origin);
                    const identity = identities.get(origin);
                    if (identity !== undefined) localIds.add(identity);
                    const ids = explicit
                      .filter(([env]) => env === identity || env === instance.id)
                      .map(([, id]) => id);
                    if (
                      identity !== undefined &&
                      ids.length === 0 &&
                      document.settings.mode === "system"
                    )
                      return { local: true, batch: { environmentId: identity, groups: [] } };
                    if (document.settings.mode === "system" && explicit.length === 0)
                      return { local: true, batch: { environmentId: identity ?? "", groups: [] } };
                    let token = tokens.get(origin);
                    if (!token) {
                      const bootstrap = config.value.bootstrap;
                      const credential =
                        bootstrap.desktopBootstrapSecret === undefined
                          ? bootstrap.desktopBootstrapToken
                          : currentDesktopBootstrapToken(
                              bootstrap.desktopBootstrapSecret,
                              yield* Clock.currentTimeMillis,
                            );
                      if (!credential)
                        return yield* new KeepAwakeSourceError({
                          cause: "Desktop bootstrap unavailable",
                        });
                      const session = yield* bootstrapRemoteBearerSession({
                        httpBaseUrl: origin,
                        credential,
                        clientMetadata: {
                          label: "Scient Desktop keep-awake",
                          deviceType: "desktop",
                        },
                      }).pipe(Effect.provideService(HttpClient.HttpClient, http));
                      token = session.access_token;
                      tokens.set(origin, token);
                    }
                    // The primary backend's persistent identity is learned without trusting renderer-provided URLs.
                    const batch = yield* fetchBatch(
                      origin,
                      token,
                      identity === undefined ? explicit.map(([, id]) => id) : ids,
                      document.settings.mode === "running",
                    );
                    localIds.add(batch.batch.environmentId);
                    return batch;
                  }),
                  true,
                  String(instance.id),
                ),
              { concurrency: 4 },
            )),
          );
          const remote = explicit.filter(
            ([env]) => !localIds.has(env) && env !== PRIMARY_LOCAL_ENVIRONMENT_ID,
          );
          const records =
            remote.length > 0
              ? yield* saved.getRegistry.pipe(
                  Effect.catch(() => {
                    results.push({
                      local: false,
                      batch: { environmentId: "", groups: [] },
                      error: "Could not load remote environment authentication.",
                    });
                    return Effect.succeed([]);
                  }),
                )
              : [];
          results.push(
            ...(yield* Effect.forEach(
              records.filter((record) => remote.some(([env]) => env === record.environmentId)),
              (record) =>
                attempt(
                  Effect.gen(function* () {
                    retainedOrigins.add(record.httpBaseUrl);
                    const ids = remote
                      .filter(([env]) => env === record.environmentId)
                      .map(([, id]) => id);

                    const token = yield* saved.getSecret(record.environmentId);
                    if (Option.isNone(token))
                      return yield* new KeepAwakeSourceError({
                        cause: "Saved authentication unavailable",
                      });
                    const result = yield* fetchBatch(
                      record.httpBaseUrl,
                      token.value,
                      ids,
                      false,
                      false,
                    );
                    return { ...result, local: false };
                  }),
                  false,
                  String(record.environmentId),
                ),
              { concurrency: 4 },
            )),
          );
          for (const origin of tokens.keys())
            if (!retainedOrigins.has(origin)) tokens.delete(origin);
          for (const origin of identities.keys())
            if (!retainedOrigins.has(origin)) identities.delete(origin);
          return results;
        },
        Effect.mapError((cause) => new KeepAwakeSourceError({ cause })),
      ),
    });
  }),
);
