import { AuthOrchestrationOperateScope, EnvironmentHttpApi } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as Option from "effect/Option";

import { annotateEnvironmentRequest, requireEnvironmentScope } from "../auth/http.ts";
import * as AnalyticsService from "./AnalyticsService.ts";
import { makeAnalyticsUiAdapter } from "./AnalyticsUiAdapter.ts";

export const scientAnalyticsHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "scientAnalytics",
  Effect.fnUntraced(function* (handlers) {
    const analytics = Option.getOrElse(
      yield* Effect.serviceOption(AnalyticsService.AnalyticsService),
      () =>
        AnalyticsService.AnalyticsService.of({
          recordOwners: Effect.fn("AnalyticsService.recordOwners")(function () {
            return Effect.void;
          }),
          record: Effect.fn("AnalyticsService.record")(function () {
            return Effect.void;
          }),
          flush: Effect.void,
          status: Effect.succeed({ available: false, consent: "off" }),
          collectionEpoch: Effect.succeed(0),
        }),
    );
    const ui = makeAnalyticsUiAdapter(analytics);
    const authorize = (endpoint: string) =>
      annotateEnvironmentRequest(endpoint).pipe(
        Effect.andThen(requireEnvironmentScope(AuthOrchestrationOperateScope)),
      );

    return handlers
      .handle(
        "status",
        Effect.fn("environment.scientAnalytics.status")(function* (args) {
          yield* authorize(args.endpoint.name);
          return yield* ui.status;
        }),
      )
      .handle(
        "record",
        Effect.fn("environment.scientAnalytics.record")(function* (args) {
          yield* authorize(args.endpoint.name);
          return yield* ui.record(args.payload);
        }),
      );
  }),
);
