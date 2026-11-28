import {
  ACCOUNTS_DESKTOP_PASSWORDS_PATH,
  ACCOUNTS_DESKTOP_WRITE_CHECK_PATH,
  DesktopPasswordImportReply,
  DesktopWriteCheckResult,
  ExecutionEnvironmentDescriptor,
  type DesktopWriteCheckInput,
  type PasswordImportInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import * as DesktopBackendPool from "../../backend/DesktopBackendPool.ts";
import * as DesktopLocalEnvironmentAuth from "../../backend/DesktopLocalEnvironmentAuth.ts";

/**
 * Round 6f: this desktop's own backend, asked by the main process with its own session, never
 * by a page. Every failure is a refusal: no answer is no grant.
 */
const call = Effect.fn("DesktopAccounts.ownBackend")(
  function* <S extends Schema.Top>(path: string, schema: S, body?: unknown) {
    const pool = yield* DesktopBackendPool.DesktopBackendPool;
    const auth = yield* DesktopLocalEnvironmentAuth.DesktopLocalEnvironmentAuth;
    const http = yield* HttpClient.HttpClient;
    const config = yield* (yield* pool.primary).currentConfig;
    if (Option.isNone(config)) return null;
    const url = new URL(path, config.value.httpBaseUrl);
    const request =
      body === undefined
        ? HttpClientRequest.get(url)
        : HttpClientRequest.post(url).pipe(HttpClientRequest.bodyJsonUnsafe(body));
    const response = yield* http.execute(
      request.pipe(HttpClientRequest.bearerToken(yield* auth.getBearerToken)),
    );
    if (response.status === 401) {
      yield* auth.forgetBearerToken;
      return null;
    }
    const decoded: S["Type"] = yield* HttpClientResponse.schemaBodyJson(schema)(
      yield* HttpClientResponse.filterStatusOk(response),
    );
    return decoded;
  },
  Effect.timeout("30 seconds"),
  Effect.catchCause(() => Effect.succeed(null)),
);

/** A browser's saved passwords, straight into this backend's Accounts. */
export const importPasswordsHere = (input: PasswordImportInput) =>
  call(ACCOUNTS_DESKTOP_PASSWORDS_PATH, DesktopPasswordImportReply, input);

let ownEnvironment: string | undefined;
/** The environment id of this desktop's own backend, as it names itself. */
const ownEnvironmentId = Effect.fn("DesktopAccounts.ownEnvironmentId")(function* () {
  if (ownEnvironment !== undefined) return ownEnvironment;
  const descriptor = yield* call("/.well-known/t3/environment", ExecutionEnvironmentDescriptor);
  if (descriptor) ownEnvironment = descriptor.environmentId;
  return descriptor?.environmentId;
});

/** Whether the operation still stands at the moment its desktop part writes; no answer is no. */
const writeStandsHere = (input: DesktopWriteCheckInput) =>
  call(ACCOUNTS_DESKTOP_WRITE_CHECK_PATH, DesktopWriteCheckResult, input).pipe(
    Effect.map((answer) => answer?.ok === true),
  );

/**
 * Round 6f: an operation's write runs in its jar's turn (`jarTurns.ts`) and asks this desktop's
 * own backend, at that moment, whether it still stands; no answer is no. Another computer's
 * operation gets no agent part here, so it is the person's.
 */
export const writeCheckFor = Effect.fn("DesktopAccounts.writeCheckFor")(function* (
  environmentId: string | undefined,
  operationId: string,
  phase: "do" | "undo",
) {
  const own = yield* ownEnvironmentId();
  if (own !== undefined && environmentId !== undefined && environmentId !== own) return undefined;
  const run = Effect.runPromiseWith(
    yield* Effect.context<
      | DesktopBackendPool.DesktopBackendPool
      | DesktopLocalEnvironmentAuth.DesktopLocalEnvironmentAuth
      | HttpClient.HttpClient
    >(),
  );
  return () => run(writeStandsHere({ operationId, phase }));
});
