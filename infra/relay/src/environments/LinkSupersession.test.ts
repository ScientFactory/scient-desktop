import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { PGlite } from "@electric-sql/pglite";
import { PgDialect } from "drizzle-orm/pg-core";

import { otherAccountLinksQuery } from "./LinkSupersession.ts";

const NOW = "2026-11-13T00:00:00.000Z";

describe("link supersession", () => {
  it.effect("finds only other accounts' active links to the same environment key", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const pg = yield* Effect.acquireRelease(
        Effect.promise(() => PGlite.create()),
        (client) => Effect.promise(() => client.close()),
      );
      const migrationsDir = yield* path.fromFileUrl(
        new URL("../../migrations/postgres/", import.meta.url),
      );
      for (const name of (yield* fs.readDirectory(migrationsDir)).toSorted()) {
        const migration = yield* fs.readFileString(`${migrationsDir}${name}/migration.sql`);
        yield* Effect.promise(() => pg.exec(migration));
      }
      const link = (userId: string, environmentId: string, key: string, revoked = false) =>
        Effect.promise(() =>
          pg.query(
            `insert into relay_environment_links
              (user_id, environment_id, environment_public_key, endpoint_http_base_url,
               endpoint_ws_base_url, endpoint_provider_kind, created_at, updated_at, revoked_at)
              values ($1, $2, $3, 'https://e', 'wss://e', 'cloudflare_tunnel', $4, $4, $5)`,
            [userId, environmentId, key, NOW, revoked ? NOW : null],
          ),
        );
      yield* link("new-owner", "env", "key");
      yield* link("old-owner", "env", "key");
      yield* link("revoked-owner", "env", "key", true);
      // Claims the same public environment id without proving its key.
      yield* link("impostor", "env", "other-key");
      yield* link("elsewhere", "other-env", "key");

      const query = new PgDialect().sqlToQuery(
        otherAccountLinksQuery({
          userId: "new-owner",
          environmentId: "env",
          environmentPublicKey: "key",
        }),
      );
      const result = yield* Effect.promise(() =>
        pg.query<{ user_id: string }>(query.sql, query.params),
      );
      expect(result.rows.map((row) => row.user_id)).toEqual(["old-owner"]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
