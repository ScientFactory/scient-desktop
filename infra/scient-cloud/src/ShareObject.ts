import * as Alchemy from "alchemy";
import * as Cloudflare from "@alchemy.run/cloudflare";
import type * as Workers from "@cloudflare/workers-types";
import * as SqliteClient from "@effect/sql-sqlite-do/SqliteClient";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";

import { bindStub } from "./bindStub.ts";
import { CloudError } from "./CloudError.ts";
import { expireShare } from "./expireShare.ts";
import { Objects, r2Objects } from "./Objects.ts";
import * as Resources from "./Resources.ts";
import { serialized } from "./runner.ts";
import { Users } from "./Services.ts";
import * as ShareStore from "./ShareStore.ts";
import { UserObject } from "./UserObject.ts";

/** One per shared link, named by the share id. Its alarm ends the link at its expiry. */
export class ShareObject extends Cloudflare.DurableObject<ShareObject, ShareStore.ShareApi>()(
  "ShareObject",
  { errors: [CloudError] },
) {}

export const layer = ShareObject.make(
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;
    const bucket = yield* Cloudflare.R2.ReadWriteBucket(yield* Resources.Storage);
    const users = yield* UserObject;
    return Effect.gen(function* () {
      const layerSql = SqliteClient.layer({ storage: state.raw.storage });
      const run = serialized((effect) => Effect.provide(effect, layerSql));
      yield* run(ShareStore.migrate);
      const scheduleExpiry = (at: number | null) =>
        Effect.promise(() =>
          at === null ? state.raw.storage.deleteAlarm() : state.raw.storage.setAlarm(at),
        );
      const api = ShareStore.makeShareApi(
        state.raw.id.name ?? state.raw.id.toString(),
        run,
        scheduleExpiry,
      );
      return {
        ...api,
        alarm: Effect.fn("ShareObject.alarm")(function* () {
          const context = yield* Alchemy.RuntimeContext;
          const objects = r2Objects((yield* bucket.raw) as unknown as Workers.R2Bucket);
          yield* expireShare(api, yield* Clock.currentTimeMillis).pipe(
            Effect.provideService(Objects, objects),
            Effect.provideService(Users, {
              get: (userId) => bindStub(users.getByName(userId), context),
            }),
          );
        }),
      };
    });
  }),
);
