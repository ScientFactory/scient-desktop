// @effect-diagnostics-next-line nodeBuiltinImport:off -- the methods Node's HTTP parser admits.
import * as NodeHttp from "node:http";
import type * as HttpMethod from "effect/http/HttpMethod";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

import { ATTACHMENT_UPLOAD_ROUTE_PREFIX } from "../../assets/AttachmentUpload.ts";
import { WEBHOOK_ROUTE_PREFIX } from "../../scheduledTasks/ScheduledTaskService.ts";

/**
 * Spans and request logs redact a signed URL's token only once a route matches, so every other
 * method and path under these prefixes gets a redacting catch-all that answers an empty 404.
 * HEAD falls back to the GET route at its path; the asset route already takes every method.
 */
const SIGNED_URL_PREFIXES: ReadonlyArray<{
  readonly prefix: `/${string}`;
  /** Methods whose real route already uses the `${prefix}/*` pattern. */
  readonly routedMethods: ReadonlyArray<string>;
}> = [
  // The webhook routes use `/:hookId/:token`, so a catch-all pattern never collides with them.
  { prefix: WEBHOOK_ROUTE_PREFIX, routedMethods: [] },
  { prefix: ATTACHMENT_UPLOAD_ROUTE_PREFIX, routedMethods: ["POST"] },
];

// Same option the signed routes in http.ts pass.
const SIGNED_URL_ROUTE_OPTIONS = { redactedParams: ["*"] };

const routeMiss = HttpServerResponse.empty({ status: 404 });

export const layer = HttpRouter.addAll(
  SIGNED_URL_PREFIXES.flatMap(({ prefix, routedMethods }) =>
    NodeHttp.METHODS.filter((method) => method !== "HEAD" && !routedMethods.includes(method)).map(
      (method) =>
        // Node accepts every method in METHODS; the router keys routes by any method string.
        HttpRouter.route(
          method as HttpMethod.HttpMethod,
          `${prefix}/*`,
          routeMiss,
          SIGNED_URL_ROUTE_OPTIONS,
        ),
    ),
  ),
);
