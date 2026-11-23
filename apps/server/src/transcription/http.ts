import {
  AuthFilesystemReadScope,
  AuthFilesystemWriteScope,
  AuthOrchestrationOperateScope,
  AuthProvidersManageScope,
  AuthSettingsWriteScope,
} from "@t3tools/contracts";
import * as ByteSize from "effect/ByteSize";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import { annotateEnvironmentRequest } from "../auth/http.ts";
import { traceAuthenticatedRelayRequest } from "../cloud/traceRelayRequest.ts";
import * as Jobs from "./TranscriptionJobs.ts";
import * as Cloud from "./CloudEngines.ts";
import * as Notes from "./RecordingNotes.ts";

const decode = Schema.decodeUnknownEffect(Schema.Union([Jobs.Request, Jobs.BatchStartRequest]));
function jobErrorResponse(error: Jobs.TranscriptionError) {
  const status = {
    busy: 409,
    "not-found": 404,
    "invalid-input": 400,
    "model-unavailable": 422,
    "cloud-upload-disabled": 403,
    io: 500,
    "consent-required": 403,
    "agent-cloud-disabled": 403,
    "tool-unavailable": 503,
  }[error.code];
  return HttpServerResponse.jsonUnsafe({ code: error.code, message: error.detail }, { status });
}

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const jobs = yield* Jobs.TranscriptionJobs;
    return HttpRouter.add(
      "POST",
      "/api/transcription/jobs",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        yield* annotateEnvironmentRequest("transcription.jobs");
        const startTime = yield* Clock.currentTimeNanos;
        const session = yield* auth.authenticateHttpRequest(request).pipe(Effect.result);
        if (session._tag === "Failure") {
          if (EnvironmentAuth.isServerAuthInternalError(session.failure)) {
            return HttpServerResponse.jsonUnsafe(
              { code: "io", message: "Could not verify the session." },
              { status: 500 },
            );
          }
          const response = HttpServerResponse.jsonUnsafe(
            { code: "unauthorized", message: "Authentication required." },
            { status: 401 },
          );
          return /^DPoP /i.test(request.headers.authorization ?? "")
            ? HttpServerResponse.setHeader(response, "www-authenticate", "DPoP")
            : response;
        }
        const endTime = yield* Clock.currentTimeNanos;
        const handle = Effect.gen(function* () {
          const scopes = session.success.scopes;
          if (
            !scopes.includes(AuthFilesystemReadScope) ||
            !scopes.includes(AuthFilesystemWriteScope) ||
            !scopes.includes(AuthOrchestrationOperateScope)
          ) {
            return HttpServerResponse.jsonUnsafe(
              {
                code: "forbidden",
                message: "This session lacks the required transcription grants.",
              },
              { status: 403 },
            );
          }
          const parsed = yield* request.json.pipe(
            Effect.provideService(HttpServerRequest.MaxBodySize, ByteSize.bytes(32 * 1024)),
            Effect.flatMap(decode),
            Effect.result,
          );
          if (parsed._tag === "Failure")
            return HttpServerResponse.jsonUnsafe(
              { code: "invalid-input", message: "Invalid transcription request." },
              { status: 400 },
            );
          const input = parsed.success;
          const result =
            input.action === "start-batch"
              ? yield* jobs.enqueue(input).pipe(Effect.result)
              : yield* jobs.execute(input).pipe(Effect.result);
          return result._tag === "Failure"
            ? jobErrorResponse(result.failure)
            : HttpServerResponse.jsonUnsafe(result.success);
        });
        return yield* session.success.subject === EnvironmentAuth.CLOUD_CONNECT_SUBJECT
          ? traceAuthenticatedRelayRequest(handle, { startTime, endTime })
          : handle;
      }),
    );
  }),
);

const decodeEngineRequest = Schema.decodeUnknownEffect(Cloud.Request);
export const enginesLayer = Layer.unwrap(
  Effect.gen(function* () {
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const engines = yield* Cloud.CloudEngines;
    return HttpRouter.add(
      "POST",
      "/api/transcription/engines",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        yield* annotateEnvironmentRequest("transcription.engines");
        const session = yield* auth.authenticateHttpRequest(request).pipe(Effect.result);
        if (session._tag === "Failure") {
          if (EnvironmentAuth.isServerAuthInternalError(session.failure))
            return HttpServerResponse.jsonUnsafe({ code: "io" }, { status: 500 });
          const response = HttpServerResponse.jsonUnsafe({ code: "unauthorized" }, { status: 401 });
          return /^DPoP /i.test(request.headers.authorization ?? "")
            ? HttpServerResponse.setHeader(response, "www-authenticate", "DPoP")
            : response;
        }
        if (
          !session.success.scopes.includes(AuthSettingsWriteScope) ||
          !session.success.scopes.includes(AuthProvidersManageScope)
        )
          return HttpServerResponse.jsonUnsafe({ code: "forbidden" }, { status: 403 });
        const parsed = yield* request.json.pipe(
          Effect.provideService(HttpServerRequest.MaxBodySize, ByteSize.bytes(32 * 1024)),
          Effect.flatMap(decodeEngineRequest),
          Effect.result,
        );
        if (parsed._tag === "Failure")
          return HttpServerResponse.jsonUnsafe({ code: "invalid-input" }, { status: 400 });
        const result = yield* engines.execute(parsed.success).pipe(Effect.result);
        if (result._tag === "Success") return HttpServerResponse.jsonUnsafe(result.success);
        const { code, detail } = result.failure;
        const status = {
          "invalid-input": 400,
          "not-found": 404,
          unavailable: 422,
          io: 500,
          "consent-required": 403,
          "provider-key-rejected": 422,
          "key-not-available-in-project": 403,
          "provider-response-too-large": 502,
        }[code];
        return HttpServerResponse.jsonUnsafe({ code, message: detail }, { status });
      }),
    );
  }),
);

const isTranscriptionError = Schema.is(Jobs.TranscriptionError);
const decodeNotesRequest = Schema.decodeUnknownEffect(Notes.Request);
export const notesLayer = Layer.unwrap(
  Effect.gen(function* () {
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const jobs = yield* Jobs.TranscriptionJobs;
    return HttpRouter.add(
      "POST",
      "/api/transcription/notes",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        yield* annotateEnvironmentRequest("transcription.notes");
        const session = yield* auth.authenticateHttpRequest(request).pipe(Effect.result);
        if (session._tag === "Failure") {
          if (EnvironmentAuth.isServerAuthInternalError(session.failure))
            return HttpServerResponse.jsonUnsafe({ code: "io" }, { status: 500 });
          const response = HttpServerResponse.jsonUnsafe({ code: "unauthorized" }, { status: 401 });
          return /^DPoP /i.test(request.headers.authorization ?? "")
            ? HttpServerResponse.setHeader(response, "www-authenticate", "DPoP")
            : response;
        }
        const scopes = session.success.scopes;
        if (
          !scopes.includes(AuthFilesystemReadScope) ||
          !scopes.includes(AuthFilesystemWriteScope) ||
          !scopes.includes(AuthOrchestrationOperateScope)
        ) {
          return HttpServerResponse.jsonUnsafe({ code: "forbidden" }, { status: 403 });
        }
        const input = yield* request.json.pipe(
          Effect.provideService(HttpServerRequest.MaxBodySize, ByteSize.bytes(32 * 1024)),
          Effect.flatMap(decodeNotesRequest),
          Effect.result,
        );
        if (input._tag === "Failure")
          return HttpServerResponse.jsonUnsafe({ code: "invalid-input" }, { status: 400 });
        const result = yield* Notes.execute(input.success).pipe(
          Effect.provideService(Jobs.TranscriptionJobs, jobs),
          Effect.result,
        );
        if (result._tag === "Success") return HttpServerResponse.jsonUnsafe(result.success);
        return isTranscriptionError(result.failure)
          ? jobErrorResponse(result.failure)
          : HttpServerResponse.jsonUnsafe({ code: "io" }, { status: 500 });
      }),
    );
  }),
);
