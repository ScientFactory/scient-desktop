import * as Cloudflare from "@alchemy.run/cloudflare";
import * as SqliteClient from "@effect/sql-sqlite-do/SqliteClient";
import * as Effect from "effect/Effect";

import { CloudError } from "./CloudError.ts";
import { serialized } from "./runner.ts";
import * as UserStore from "./UserStore.ts";

/** One per Clerk user, named by the user id. */
export class UserObject extends Cloudflare.DurableObject<UserObject, UserStore.UserApi>()(
  "UserObject",
  { errors: [CloudError] },
) {}

export const layer = UserObject.make(
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;
    return Effect.gen(function* () {
      const layerSql = SqliteClient.layer({ storage: state.raw.storage });
      const run = serialized((effect) => Effect.provide(effect, layerSql));
      yield* run(UserStore.migrate);
      return UserStore.makeUserApi(state.raw.id.name ?? state.raw.id.toString(), run);
    });
  }),
);
