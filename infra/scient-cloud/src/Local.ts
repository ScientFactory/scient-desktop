// @effect-diagnostics nodeBuiltinImport:off - the local stand-in reads the share build from disk.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import type * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

import { importKek } from "./AtRest.ts";
import { cloudError } from "./CloudError.ts";
import { expireShare } from "./expireShare.ts";
import { memoryObjects, Objects } from "./Objects.ts";
import { serialized } from "./runner.ts";
import {
  CloudConfig,
  PageAssets,
  PeopleAuth,
  Shares,
  Users,
  type CloudSettings,
} from "./Services.ts";
import * as ShareStore from "./ShareStore.ts";
import * as UserStore from "./UserStore.ts";

/**
 * The Worker's services in one Node process: SQLite per user and per share, objects in memory
 * (or files), and test sign-in. Used by the tests and `scripts/dev.ts`; the deployed Worker
 * never imports this file.
 */

export interface LocalPerson {
  readonly userId: string;
  readonly emails?: ReadonlyArray<string>;
}

export interface LocalCloudOptions {
  readonly settings?: Partial<Omit<CloudSettings, "kek">>;
  /** 32 bytes, base64url. A fixed test key is used when omitted. */
  readonly kek?: string;
  /** SQLite files go here; in memory when omitted. */
  readonly dataDir?: string;
  /** Test sign-in: bearer token → person. */
  readonly people: ReadonlyMap<string, LocalPerson>;
  /** Share page build to serve under `/s/_app/`. */
  readonly shareDist?: string;
  readonly objects?: Map<string, Uint8Array>;
}

/** Test-only key-encryption key; production refuses to start without `SCIENT_CLOUD_KEK`. */
export const LOCAL_TEST_KEK = "c2NpZW50LWxvY2FsLXRlc3Qta2V5LW5vdC1zZWNyZXQ";

const objectRun = (
  scope: Scope.Scope,
  filename: string,
  migrate: Effect.Effect<void, SqlError, SqlClient.SqlClient>,
) => {
  let context: Context.Context<SqlClient.SqlClient> | undefined;
  const ensure = Effect.suspend(() =>
    context !== undefined
      ? Effect.succeed(context)
      : Layer.buildWithScope(NodeSqliteClient.layer({ filename }), scope).pipe(
          Effect.tap((built) => Effect.provide(migrate, built)),
          Effect.tap((built) => Effect.sync(() => (context = built))),
          Effect.orDie,
        ),
  );
  return serialized((effect) => Effect.flatMap(ensure, (built) => Effect.provide(effect, built)));
};

const contentType = (path: string) =>
  ({
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".woff2": "font/woff2",
    ".wasm": "application/wasm",
  })[NodePath.extname(path)] ?? "application/octet-stream";

const directoryAssets = (root: string | undefined): PageAssets["Service"] => ({
  fetch: (path) =>
    Effect.sync(() => {
      if (root === undefined) return undefined;
      const file = NodePath.resolve(root, path);
      if (!file.startsWith(NodePath.resolve(root) + NodePath.sep)) return undefined;
      if (!NodeFS.existsSync(file) || !NodeFS.statSync(file).isFile()) return undefined;
      return new Response(NodeFS.readFileSync(file), {
        headers: { "content-type": contentType(file) },
      });
    }),
});

const sanitize = (name: string) => name.replace(/[^A-Za-z0-9_-]/gu, "_");

export class LocalAlarms extends Context.Service<
  LocalAlarms,
  {
    /** Runs every share alarm due at `now`, as Durable Object alarms would. */
    readonly runDue: (now: number) => Effect.Effect<void>;
    readonly pending: () => ReadonlyMap<string, number | null>;
  }
>()("@scientfactory/scient-cloud-worker/Local/LocalAlarms") {}

export const layer = (options: LocalCloudOptions) =>
  Layer.effectContext(
    Effect.gen(function* () {
      const scope = yield* Effect.scope;
      const kek = yield* importKek(options.kek ?? LOCAL_TEST_KEK);
      const settings: CloudSettings = {
        apiOrigin: "http://localhost:8787",
        pageOrigin: "http://localhost:8787",
        contentOrigin: "http://localhost:8787",
        appOrigins: [],
        allowLocalhostOrigins: true,
        limits: {
          freeBytes: 1024 ** 3,
          maxSnapshotBytes: 64 * 1024 ** 2,
          maxBlobBytes: 25 * 1024 ** 2,
          maxThreads: 10_000,
        },
        adminToken: null,
        ...options.settings,
        kek,
      };
      const filename = (kind: string, id: string) =>
        options.dataDir === undefined
          ? ":memory:"
          : NodePath.join(options.dataDir, `${kind}-${sanitize(id)}.sqlite`);
      if (options.dataDir !== undefined) NodeFS.mkdirSync(options.dataDir, { recursive: true });

      const users = new Map<string, UserStore.UserApi>();
      const usersService = Users.of({
        get: (userId) => {
          let api = users.get(userId);
          if (api === undefined) {
            api = UserStore.makeUserApi(
              userId,
              objectRun(scope, filename("user", userId), UserStore.migrate),
            );
            users.set(userId, api);
          }
          return api;
        },
      });

      const alarms = new Map<string, number | null>();
      const shares = new Map<string, ShareStore.ShareApi>();
      const sharesService = Shares.of({
        get: (shareId) => {
          let api = shares.get(shareId);
          if (api === undefined) {
            api = ShareStore.makeShareApi(
              shareId,
              objectRun(scope, filename("share", shareId), ShareStore.migrate),
              (at) => Effect.sync(() => void alarms.set(shareId, at)),
            );
            shares.set(shareId, api);
          }
          return api;
        },
      });

      const people = PeopleAuth.of({
        verify: Effect.fn("LocalPeopleAuth.verify")(function* (token: string) {
          const person = options.people.get(token);
          if (person === undefined) {
            return yield* cloudError("unauthorized", "Sign in to continue.");
          }
          return { userId: person.userId };
        }),
        verifiedEmails: Effect.fn("LocalPeopleAuth.verifiedEmails")((userId: string) =>
          Effect.sync(() =>
            [...options.people.values()]
              .filter((person) => person.userId === userId)
              .flatMap((person) => person.emails ?? [])
              .map((email) => email.toLowerCase()),
          ),
        ),
      });

      const objects = memoryObjects(options.objects);
      const context = Layer.mergeAll(
        Layer.succeed(Users, usersService),
        Layer.succeed(Shares, sharesService),
        Layer.succeed(PeopleAuth, people),
        Layer.succeed(Objects, objects),
        Layer.succeed(CloudConfig, settings),
        Layer.succeed(PageAssets, directoryAssets(options.shareDist)),
        Layer.succeed(LocalAlarms, {
          runDue: Effect.fn("LocalAlarms.runDue")(function* (now: number) {
            yield* Effect.forEach(
              [...alarms].filter(([, at]) => at !== null && at <= now),
              ([shareId]) =>
                expireShare(sharesService.get(shareId), now).pipe(
                  Effect.tap(() => Effect.sync(() => alarms.set(shareId, null))),
                ),
              { discard: true },
            ).pipe(
              Effect.provideService(Users, usersService),
              Effect.provideService(Objects, objects),
            );
          }),
          pending: () => new Map(alarms),
        }),
      );
      return yield* Layer.build(context);
    }),
  );
