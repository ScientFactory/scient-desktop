/**
 * DesktopUpdateFactsRoute - the desktop's update facts over HTTP, for a backend started without
 * the telemetry pipes (a WSL-only primary). Same ingest and same acknowledgement as the pipe:
 * the response lists the ids the outbox holds, which the desktop may then forget.
 *
 * @module DesktopUpdateFactsRoute
 */
import {
  AuthEnvironmentMaintainScope,
  DESKTOP_UPDATE_FACTS_HTTP_PATH,
  DesktopUpdateFactsHttpRequest,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import { ingestDesktopUpdateFacts } from "./DesktopUpdateFacts.ts";
import { ScientRecordedAnalyticsIngest } from "./ScientAnalytics.ts";

const MAX_BODY_BYTES = 256 * 1024;
const decodeRequest = Schema.decodeUnknownEffect(
  Schema.fromJsonString(DesktopUpdateFactsHttpRequest),
);

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const recorded = yield* ScientRecordedAnalyticsIngest;
    const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
    return HttpRouter.add(
      "POST",
      DESKTOP_UPDATE_FACTS_HTTP_PATH,
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const session = yield* serverAuth.authenticateHttpRequest(request).pipe(Effect.option);
        if (session._tag === "None") {
          return HttpServerResponse.text("Unauthorized", { status: 401 });
        }
        if (!session.value.scopes.includes(AuthEnvironmentMaintainScope)) {
          return HttpServerResponse.text("Forbidden", { status: 403 });
        }
        const declared = Number(request.headers["content-length"] ?? 0);
        if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
          return HttpServerResponse.text("Payload Too Large", { status: 413 });
        }
        const body = yield* request.text.pipe(Effect.option);
        if (body._tag === "None" || body.value.length > MAX_BODY_BYTES) {
          return HttpServerResponse.text("Bad Request", { status: 400 });
        }
        const parsed = yield* decodeRequest(body.value).pipe(Effect.option);
        if (parsed._tag === "None") {
          return HttpServerResponse.text("Bad Request", { status: 400 });
        }
        const ids = yield* ingestDesktopUpdateFacts(recorded, parsed.value.facts);
        return HttpServerResponse.jsonUnsafe({ ids });
      }),
    );
  }),
);
