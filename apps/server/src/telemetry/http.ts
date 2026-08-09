import { AuthOrchestrationOperateScope, EnvironmentHttpApi } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as Option from "effect/Option";

import {
  annotateEnvironmentRequest,
  failEnvironmentInternal,
  requireEnvironmentScope,
} from "../auth/http.ts";
import * as AnalyticsService from "./AnalyticsService.ts";

export const scientAnalyticsHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "scientAnalytics",
  Effect.fnUntraced(function* (handlers) {
    const analytics = Option.getOrElse(
      yield* Effect.serviceOption(AnalyticsService.AnalyticsService),
      () =>
        AnalyticsService.AnalyticsService.of({
          record: () => Effect.void,
          flush: Effect.void,
          status: Effect.succeed({ available: false, consent: "off" }),
          setConsent: () => Effect.succeed({ available: false, consent: "off" }),
          deleteData: Effect.succeed(false),
        }),
    );
    const authorize = (endpoint: string) =>
      annotateEnvironmentRequest(endpoint).pipe(
        Effect.andThen(requireEnvironmentScope(AuthOrchestrationOperateScope)),
      );

    return handlers
      .handle(
        "status",
        Effect.fn("environment.scientAnalytics.status")(function* (args) {
          yield* authorize(args.endpoint.name);
          return yield* analytics.status;
        }),
      )
      .handle(
        "preferences",
        Effect.fn("environment.scientAnalytics.preferences")(function* (args) {
          yield* authorize(args.endpoint.name);
          return yield* analytics.setConsent(args.payload.consent);
        }),
      )
      .handle(
        "record",
        Effect.fn("environment.scientAnalytics.record")(function* (args) {
          yield* authorize(args.endpoint.name);
          yield* analytics.record(args.payload.name, args.payload.properties);
          return { accepted: true } as const;
        }),
      )
      .handle(
        "deleteData",
        Effect.fn("environment.scientAnalytics.deleteData")(function* (args) {
          yield* authorize(args.endpoint.name);
          const deleted = yield* analytics.deleteData;
          if (!deleted) {
            return yield* failEnvironmentInternal(
              "scient_analytics_deletion_failed",
              "analytics-deletion-not-acknowledged",
            );
          }
          return { deleted: true } as const;
        }),
      );
  }),
);
