// SCIENT-FORK:START link-supersession — whole file.
import { sql } from "drizzle-orm";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as RelayDb from "../db.ts";
import { relayEnvironmentLinks } from "../persistence/schema.ts";

export class LinkSupersessionPersistenceError extends Schema.TaggedError<LinkSupersessionPersistenceError>()(
  "LinkSupersessionPersistenceError",
  { cause: Schema.Defect() },
) {}

/**
 * Other accounts with an active link to the same environment key. Matching the proven key, not
 * the public environment id, keeps anyone else's computer out of reach.
 */
export const otherAccountLinksQuery = (input: {
  readonly userId: string;
  readonly environmentId: string;
  readonly environmentPublicKey: string;
}) => sql`select distinct ${relayEnvironmentLinks.userId} as user_id
  from ${relayEnvironmentLinks}
  where ${relayEnvironmentLinks.environmentId} = ${input.environmentId}
    and ${relayEnvironmentLinks.environmentPublicKey} = ${input.environmentPublicKey}
    and ${relayEnvironmentLinks.revokedAt} is null
    and ${relayEnvironmentLinks.userId} <> ${input.userId}`;

/**
 * A desktop holds one account's link at a time, so the relay ends other accounts' links to an
 * environment once that environment proves its key to link another account.
 */
export class LinkSupersession extends Context.Service<
  LinkSupersession,
  {
    readonly otherAccountUserIds: (input: {
      readonly userId: string;
      readonly environmentId: string;
      readonly environmentPublicKey: string;
    }) => Effect.Effect<ReadonlyArray<string>, LinkSupersessionPersistenceError>;
  }
>()("t3code-relay/environments/LinkSupersession") {}

export const make = Effect.gen(function* () {
  const db = yield* RelayDb.RelayDb;
  return LinkSupersession.of({
    otherAccountUserIds: Effect.fn("relay.link_supersession.other_account_user_ids")(
      function* (input) {
        const rows = yield* db
          .execute<{ user_id: string }>(otherAccountLinksQuery(input))
          .pipe(Effect.mapError((cause) => new LinkSupersessionPersistenceError({ cause })));
        return rows.rows.map((row) => row.user_id);
      },
    ),
  });
});

export const layer = Layer.effect(LinkSupersession, make);
// SCIENT-FORK:END link-supersession
