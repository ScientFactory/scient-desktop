// @effect-diagnostics nodeBuiltinImport:off - the deploy plan checks whether the share app was built.
import * as NodeFS from "node:fs";

import type * as Alchemy from "alchemy";
import * as Cloudflare from "@alchemy.run/cloudflare";
import type * as Workers from "@cloudflare/workers-types";
import { WorkerEnvironment } from "@alchemy.run/cloudflare/Workers/WorkerRuntime";
import { DEFAULT_CLOUD_LIMITS } from "@scientfactory/scient-cloud/limits";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

import { handle } from "./Api.ts";
import { importKek } from "./AtRest.ts";
import { bindStub } from "./bindStub.ts";
import { clerkPeopleAuth } from "./ClerkAuth.ts";
import { DeploymentConfig } from "./DeploymentConfig.ts";
import { Objects, r2Objects } from "./Objects.ts";
import * as Resources from "./Resources.ts";
import { CloudConfig, PageAssets, PeopleAuth, Shares, Users } from "./Services.ts";
import * as ShareObject from "./ShareObject.ts";
import * as UserObject from "./UserObject.ts";

const SHARE_DIST = new URL("../share/dist", import.meta.url);
/** The hosted app and the desktop app (production and development builds). */
const DEFAULT_APP_ORIGINS = "https://app.scientfactory.com,scient://app,scient-next-dev://app";

const zoneOf = (host: string) => host.split(".").slice(-2).join(".");

const limitConfig = (name: string, fallback: number) =>
  Config.Int(name).pipe(Config.withDefault(fallback));

export class Worker extends Cloudflare.Worker<Worker, {}>()("ScientCloud") {}

export const layer = Worker.make(
  Effect.gen(function* () {
    const name = yield* Resources.workerName;
    const { apiHost, pageHost, contentHost } = yield* DeploymentConfig;
    const hasShareApp = NodeFS.existsSync(new URL("index.html", `${SHARE_DIST.href}/`));
    return {
      name,
      main: import.meta.filename,
      compatibility: { date: "2026-09-11", flags: ["nodejs_compat"] },
      domain: { name: apiHost, aliases: [contentHost] },
      // A route wins over the website's custom domain for these paths only.
      routes: [{ pattern: `${pageHost}/s/*`, zoneName: zoneOf(pageHost) }],
      ...(hasShareApp
        ? {
            assets: {
              directory: SHARE_DIST.pathname,
              config: { runWorkerFirst: true, htmlHandling: "none" as const },
            },
          }
        : {}),
    };
  }).pipe(Effect.orDie),
  Effect.gen(function* () {
    const { apiHost, pageHost, contentHost } = yield* DeploymentConfig;
    const bucket = yield* Cloudflare.R2.ReadWriteBucket(yield* Resources.Storage);
    const users = yield* UserObject.UserObject;
    const shares = yield* ShareObject.ShareObject;
    const runtimeContext: Alchemy.BaseRuntimeContext = yield* Cloudflare.Worker;

    const kekSecret = yield* Config.Redacted("SCIENT_CLOUD_KEK");
    const clerkSecretKey = yield* Config.Redacted("CLERK_SECRET_KEY");
    const clerkJwtAudience = yield* Config.String("CLERK_JWT_AUDIENCE");
    const adminToken = yield* Config.option(Config.Redacted("SCIENT_CLOUD_ADMIN_TOKEN"));
    const appOrigins = yield* Config.String("SCIENT_CLOUD_APP_ORIGINS").pipe(
      Config.withDefault(DEFAULT_APP_ORIGINS),
    );
    const limits = {
      freeBytes: yield* limitConfig("SCIENT_CLOUD_FREE_BYTES", DEFAULT_CLOUD_LIMITS.freeBytes),
      maxSnapshotBytes: yield* limitConfig(
        "SCIENT_CLOUD_MAX_SNAPSHOT_BYTES",
        DEFAULT_CLOUD_LIMITS.maxSnapshotBytes,
      ),
      maxBlobBytes: yield* limitConfig(
        "SCIENT_CLOUD_MAX_BLOB_BYTES",
        DEFAULT_CLOUD_LIMITS.maxBlobBytes,
      ),
      maxThreads: yield* limitConfig("SCIENT_CLOUD_MAX_THREADS", DEFAULT_CLOUD_LIMITS.maxThreads),
    };
    const kek = yield* Effect.cached(importKek(Redacted.value(kekSecret)));
    const people = clerkPeopleAuth({
      secretKey: Redacted.value(clerkSecretKey),
      audience: clerkJwtAudience,
    });

    const services = Effect.gen(function* () {
      const assets = (yield* WorkerEnvironment).ASSETS as Fetcher | undefined;
      return Layer.mergeAll(
        Layer.succeed(Users, {
          get: (userId) => bindStub(users.getByName(userId), runtimeContext),
        }),
        Layer.succeed(Shares, {
          get: (shareId) => bindStub(shares.getByName(shareId), runtimeContext),
        }),
        Layer.succeed(PeopleAuth, people),
        Layer.succeed(Objects, r2Objects((yield* bucket.raw) as unknown as Workers.R2Bucket)),
        Layer.succeed(PageAssets, {
          fetch: Effect.fn("ShareAppAssets.fetch")(function* (path: string) {
            if (assets === undefined) return undefined;
            return yield* Effect.promise(() => assets.fetch(`https://assets.local/${path}`));
          }),
        }),
        Layer.succeed(CloudConfig, {
          apiOrigin: `https://${apiHost}`,
          pageOrigin: `https://${pageHost}`,
          contentOrigin: `https://${contentHost}`,
          appOrigins: appOrigins
            .split(",")
            .map((origin) => origin.trim())
            .filter(Boolean),
          // Production never allows localhost origins; `scripts/dev.ts` does.
          allowLocalhostOrigins: false,
          limits,
          kek: yield* kek,
          adminToken: Option.match(adminToken, {
            onNone: () => null,
            onSome: (token) => Redacted.value(token),
          }),
        }),
      );
    });

    return {
      fetch: Effect.gen(function* () {
        const request = yield* Cloudflare.Workers.Request;
        const response = yield* handle(request).pipe(Effect.provide(yield* services));
        return HttpServerResponse.fromWeb(response);
      }),
    };
  }).pipe(
    Effect.provide(
      Layer.empty.pipe(
        Layer.provideMerge(ShareObject.layer),
        Layer.provideMerge(UserObject.layer),
        Layer.provideMerge(Cloudflare.R2.ReadWriteBucketBinding),
      ),
    ),
  ),
);

// Alchemy's generated Worker entry imports the runtime layer as the default export.
export default layer;
