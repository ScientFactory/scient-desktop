import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { PGlite } from "@electric-sql/pglite";
import { getColumns, isTable } from "drizzle-orm";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";

import * as Schema from "../persistence/schema.ts";
import { accountRecordDeletions } from "./AccountRecords.ts";

const NOW = "2026-11-11T00:00:00.000Z";

// Tables that name a user, and the environment-keyed tables an account's links own.
const SEEDED_TABLES = [
  "relay_agent_activity_rows",
  "relay_delivery_attempts",
  "relay_environment_credentials",
  "relay_environment_links",
  "relay_live_activities",
  "relay_managed_endpoint_allocations",
  "relay_managed_tunnel_limits",
  "relay_mobile_devices",
];

const seedUser = (pg: PGlite, userId: string) =>
  Effect.promise(async () => {
    const device = `${userId}-device`;
    await pg.query(
      `insert into relay_mobile_devices (user_id, device_id, platform, preferences_json, created_at, updated_at)
        values ($1, $2, 'ios', '{}'::jsonb, $3, $3)`,
      [userId, device, NOW],
    );
    await pg.query(
      `insert into relay_live_activities (user_id, device_id, created_at, updated_at) values ($1, $2, $3, $3)`,
      [userId, device, NOW],
    );
    await pg.query(
      `insert into relay_delivery_attempts (id, created_at, user_id, device_id, kind)
        values ($1, $2, $3, $4, 'alert'), ($5, $2, null, $4, 'alert')`,
      [`${userId}-a`, NOW, userId, device, `${userId}-b`],
    );
    await pg.query(
      `insert into relay_managed_tunnel_limits (user_id, max_tunnels, created_at, updated_at)
        values ($1, 5, $2, $2)`,
      [userId, NOW],
    );
  });

const seedLink = (pg: PGlite, userId: string, environmentId: string, publicKey: string) =>
  Effect.promise(async () => {
    await pg.query(
      `insert into relay_environment_links
        (user_id, environment_id, environment_public_key, endpoint_http_base_url, endpoint_ws_base_url,
         endpoint_provider_kind, created_at, updated_at)
        values ($1, $2, $3, 'https://e', 'wss://e', 'cloudflare_tunnel', $4, $4)`,
      [userId, environmentId, publicKey, NOW],
    );
    await pg.query(
      `insert into relay_environment_credentials
        (credential_id, environment_id, environment_public_key, credential_hash, created_at, updated_at)
        values ($1, $2, $3, $1, $4, $4)
        on conflict do nothing`,
      [`${environmentId}-${publicKey}`, environmentId, publicKey, NOW],
    );
    await pg.query(
      `insert into relay_agent_activity_rows
        (environment_id, environment_public_key, thread_id, state_json, created_at, updated_at)
        values ($1, $2, 'thread-1', '{}'::jsonb, $3, $3)
        on conflict do nothing`,
      [environmentId, publicKey, NOW],
    );
  });

const countRows = (pg: PGlite) =>
  Effect.promise(async () => {
    const counts: Record<string, number> = {};
    for (const table of SEEDED_TABLES) {
      const result = await pg.query<{ count: number }>(
        `select count(*)::int as count from ${table}`,
      );
      counts[table] = result.rows[0]?.count ?? 0;
    }
    return counts;
  });

describe("account record deletion", () => {
  it("covers every table that stores a user id", () => {
    const userTables = Object.values(Schema)
      .filter(isTable)
      .filter((table) =>
        Object.values(getColumns(table)).some((column) => column.name === "user_id"),
      )
      .map((table) => getTableConfig(table).name)
      .toSorted();
    // A new one needs a statement in accountRecordDeletions and a seed row below. Allocations
    // leave through deprovisioning, which deletes their Cloudflare tunnel and DNS record first.
    expect(userTables).toEqual(
      SEEDED_TABLES.filter(
        (name) => name !== "relay_agent_activity_rows" && name !== "relay_environment_credentials",
      ),
    );
  });

  it.effect("removes only the account's rows and can run again", () =>
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

      yield* seedUser(pg, "user-1");
      yield* seedUser(pg, "user-2");
      yield* seedLink(pg, "user-1", "env-own", "key-own");
      // A computer both accounts linked keeps its credential and activity for the other account.
      yield* seedLink(pg, "user-1", "env-shared", "key-shared");
      yield* seedLink(pg, "user-2", "env-shared", "key-shared");
      yield* Effect.promise(() =>
        pg.query(
          `insert into relay_managed_endpoint_allocations
            (user_id, environment_id, hostname, tunnel_name, created_at, updated_at)
            values ('user-2', 'env-shared', 'h', 't', $1, $1)`,
          [NOW],
        ),
      );
      // regression: account switching on one phone reuses its device id; the other account keeps its history.
      yield* Effect.promise(() =>
        pg.query(
          `insert into relay_delivery_attempts (id, created_at, user_id, device_id, kind)
            values ('user-2-on-user-1-phone', $1, 'user-2', 'user-1-device', 'alert')`,
          [NOW],
        ),
      );
      const before = yield* countRows(pg);

      const dialect = new PgDialect();
      const deleteAccount = Effect.promise(async () => {
        for (const statement of accountRecordDeletions("user-1")) {
          const query = dialect.sqlToQuery(statement);
          await pg.query(query.sql, query.params);
        }
      });
      yield* deleteAccount;
      const after = yield* countRows(pg);
      yield* deleteAccount;

      expect(yield* countRows(pg)).toEqual(after);
      expect(after).toEqual({
        ...before,
        relay_agent_activity_rows: 1,
        relay_delivery_attempts: 3,
        relay_environment_credentials: 1,
        relay_environment_links: 1,
        relay_live_activities: 1,
        relay_managed_tunnel_limits: 1,
        relay_mobile_devices: 1,
      });
      const remainingUsers = yield* Effect.promise(() =>
        pg.query<{ user_id: string }>(
          `select user_id from relay_environment_links
            union select user_id from relay_mobile_devices
            union select user_id from relay_live_activities
            union select user_id from relay_managed_tunnel_limits
            union select coalesce(user_id, device_id) from relay_delivery_attempts`,
        ),
      );
      expect(remainingUsers.rows.map((row) => row.user_id).toSorted()).toEqual([
        "user-2",
        "user-2-device",
      ]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
