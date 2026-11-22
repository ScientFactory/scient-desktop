import * as Alchemy from "alchemy";
import type * as Workers from "@cloudflare/workers-types";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

import { handle } from "./Api.ts";
import { bindingRateLimits, d1FeedbackSql, r2Files } from "./Bindings.ts";
import * as Resources from "./Resources.ts";
import {
  DEFAULT_FEEDBACK_SETTINGS,
  FeedbackConfig,
  FeedbackSql,
  Files,
  RateLimits,
} from "./Services.ts";

const PRODUCTION_HOST = "feedback.scientfactory.com";

// CI passes unset variables as empty strings; blank means the default.
const textConfig = (name: string, fallback: string) =>
  Config.String(name).pipe(
    Config.withDefault(""),
    Config.map((value) => value.trim() || fallback),
  );

export class Worker extends Cloudflare.Worker<Worker, {}>()("ScientFeedback") {}

export const layer = Worker.make(
  Effect.gen(function* () {
    const { stage } = yield* Alchemy.Stack;
    const host = yield* textConfig("SCIENT_FEEDBACK_HOST", stage === "prod" ? PRODUCTION_HOST : "");
    return {
      name: yield* Resources.workerName,
      main: import.meta.filename,
      compatibility: { date: "2026-09-11", flags: ["nodejs_compat"] },
      // A non-production stage without a host is reachable only on its workers.dev URL.
      ...(host ? { domain: { name: host } } : {}),
    };
  }),
  Effect.gen(function* () {
    const database = yield* Cloudflare.D1.QueryDatabase(yield* Resources.Reports);
    const bucket = yield* Cloudflare.R2.ReadWriteBucket(yield* Resources.Attachments);
    const reportClient = yield* Cloudflare.RateLimit("REPORT_CLIENT_LIMITER", {
      namespaceId: "4101",
      simple: { limit: 3, period: 60 },
    });
    const reportNetwork = yield* Cloudflare.RateLimit("REPORT_NETWORK_LIMITER", {
      namespaceId: "4102",
      simple: { limit: 10, period: 60 },
    });
    const statusClient = yield* Cloudflare.RateLimit("STATUS_CLIENT_LIMITER", {
      namespaceId: "4103",
      simple: { limit: 10, period: 60 },
    });
    const adminToken = yield* Config.option(Config.Redacted("SCIENT_FEEDBACK_ADMIN_TOKEN"));
    const ingestion = yield* textConfig("SCIENT_FEEDBACK_INGESTION_ENABLED", "true");
    const dailyCap = yield* textConfig(
      "SCIENT_FEEDBACK_DAILY_CAP",
      String(DEFAULT_FEEDBACK_SETTINGS.dailyReportCap),
    );

    const services = Effect.gen(function* () {
      return Layer.mergeAll(
        Layer.succeed(
          FeedbackSql,
          d1FeedbackSql((yield* database.raw) as unknown as Workers.D1Database),
        ),
        Layer.succeed(Files, r2Files((yield* bucket.raw) as unknown as Workers.R2Bucket)),
        Layer.succeed(
          RateLimits,
          bindingRateLimits({
            "report-client": (yield* reportClient.raw) as unknown as Workers.RateLimit,
            "report-network": (yield* reportNetwork.raw) as unknown as Workers.RateLimit,
            "status-client": (yield* statusClient.raw) as unknown as Workers.RateLimit,
          }),
        ),
        Layer.succeed(FeedbackConfig, {
          ...DEFAULT_FEEDBACK_SETTINGS,
          ingestionEnabled: ingestion !== "false",
          dailyReportCap: Number(dailyCap) || DEFAULT_FEEDBACK_SETTINGS.dailyReportCap,
          adminToken: Option.match(adminToken, {
            onNone: () => null,
            onSome: (token) => Redacted.value(token).trim() || null,
          }),
        }),
      );
    });

    return {
      fetch: Effect.gen(function* () {
        const request = yield* Cloudflare.Workers.Request;
        const response = yield* handle(request as unknown as Request).pipe(
          Effect.provide(yield* services),
        );
        return HttpServerResponse.fromWeb(response);
      }),
    };
  }).pipe(
    Effect.provide([
      Cloudflare.D1.QueryDatabaseBinding,
      Cloudflare.R2.ReadWriteBucketBinding,
      Cloudflare.Workers.RateLimitBinding,
    ]),
  ),
);

// Alchemy's generated Worker entry imports the runtime layer as the default export.
export default layer;
