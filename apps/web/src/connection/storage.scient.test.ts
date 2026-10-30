import { ConnectionCatalogDocument } from "@t3tools/client-runtime/platform";
import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as ConnectionStorage from "./storage";

const decodeCatalog = Schema.decodeUnknownSync(Schema.fromJsonString(ConnectionCatalogDocument));
const encodeCatalog = Schema.encodeSync(Schema.fromJsonString(ConnectionCatalogDocument));
const catalog = (...disabledEnvironmentIds: ReadonlyArray<string>) =>
  encodeCatalog({
    schemaVersion: 1,
    targets: [],
    profiles: [],
    credentials: [],
    remoteDpopTokens: [],
    disabledEnvironmentIds: disabledEnvironmentIds.map((id) => EnvironmentId.make(id)),
  });

/** One saved catalog that this window and another window both write. */
function sharedBackend(exclusive?: ConnectionStorage.CatalogBackend["exclusive"]) {
  const saved = { raw: catalog("a") };
  const backend: ConnectionStorage.CatalogBackend = {
    read: Effect.sync(() => saved.raw),
    write: (raw) =>
      Effect.sync(() => {
        saved.raw = raw;
      }),
    ...(exclusive === undefined ? {} : { exclusive }),
  };
  return { saved, backend };
}

const disable = (id: string) => (document: ConnectionCatalogDocument) => ({
  ...document,
  disabledEnvironmentIds: [...document.disabledEnvironmentIds, EnvironmentId.make(id)],
});

describe("connection catalog saved by another desktop window", () => {
  it.effect("is read again after its change notice", () =>
    Effect.gen(function* () {
      const { saved, backend } = sharedBackend();
      const store = yield* ConnectionStorage.makeCatalogStore(backend);
      expect((yield* store.read).disabledEnvironmentIds).toEqual(["a"]);

      saved.raw = catalog("a", "b");
      expect((yield* store.read).disabledEnvironmentIds).toEqual(["a"]);
      store.invalidate();
      expect((yield* store.read).disabledEnvironmentIds).toEqual(["a", "b"]);
    }),
  );

  it.effect("survives this window's next update, which reads it again under the lock", () =>
    Effect.gen(function* () {
      const { saved, backend } = sharedBackend((effect) => effect);
      const store = yield* ConnectionStorage.makeCatalogStore(backend);
      yield* store.read;

      // The other window's change notice has not arrived yet.
      saved.raw = catalog("a", "b");
      yield* store.update(disable("c"));

      expect(decodeCatalog(saved.raw).disabledEnvironmentIds).toEqual(["a", "b", "c"]);
    }),
  );
});
