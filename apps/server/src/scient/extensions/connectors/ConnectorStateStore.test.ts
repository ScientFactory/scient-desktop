// @effect-diagnostics nodeBuiltinImport:off -- These tests seed and inspect the real state file.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  CONNECTOR_STATE_FILE,
  ConnectorRecord,
  makeConnectorStateStore,
  MAX_STATE_BYTES,
} from "./ConnectorStateStore.ts";

const encodeRecord = Schema.encodeSync(ConnectorRecord);
const record = Schema.decodeSync(ConnectorRecord)({
  connectorId: "con_abcdefgh",
  serverName: "service",
  displayName: "Service",
  url: "https://service.example.com/mcp",
  source: { type: "url" },
  auth: { type: "none" },
  status: "connected",
  enabled: true,
  authRevision: 0,
  availability: { type: "all-projects" },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

/** A fresh state directory holding `content` as the state file. */
const seededDirectory = (content: string) =>
  Effect.acquireRelease(
    Effect.promise(async () => {
      const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "connector-state-"));
      await NodeFSP.writeFile(NodePath.join(directory, CONNECTOR_STATE_FILE), content);
      return directory;
    }),
    (directory) => Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
  );

const stateText = (directory: string) =>
  Effect.promise(() => NodeFSP.readFile(NodePath.join(directory, CONNECTOR_STATE_FILE), "utf8"));

/** A format-2 file with one preserved (unreadable) entry padded by `pad` characters. */
const paddedFile = (pad: number) =>
  JSON.stringify({ formatVersion: 2, connectors: [{ preserved: "x".repeat(pad) }] });

const addRecord = (directory: string) =>
  Effect.gen(function* () {
    const store = yield* makeConnectorStateStore(directory);
    return yield* store.update((current) =>
      Effect.succeed([undefined, { connectors: [...current.connectors, record] }] as const),
    );
  });

describe("connector state size limit", () => {
  it.live("commits a write of exactly the limit and refuses one byte more", () =>
    Effect.gen(function* () {
      // Measure the written size once; padding the preserved entry is byte for byte.
      const probe = yield* seededDirectory(paddedFile(10));
      yield* addRecord(probe);
      const probeBytes = Buffer.byteLength(yield* stateText(probe));
      const exactPad = 10 + MAX_STATE_BYTES - probeBytes;

      const exact = yield* seededDirectory(paddedFile(exactPad));
      yield* addRecord(exact);
      expect(Buffer.byteLength(yield* stateText(exact))).toBe(MAX_STATE_BYTES);
      const reloaded = yield* (yield* makeConnectorStateStore(exact)).read;
      expect(reloaded.writable).toBe(true);
      expect(reloaded.connectors).toEqual([record]);
      expect(reloaded.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
        "connector-record-unreadable",
      ]);

      const seed = paddedFile(exactPad + 1);
      const over = yield* seededDirectory(seed);
      const store = yield* makeConnectorStateStore(over);
      const refused = yield* Effect.flip(
        store.update((current) =>
          Effect.succeed([undefined, { connectors: [...current.connectors, record] }] as const),
        ),
      );
      expect(refused.reason).toBe("limit-reached");
      // Neither the file nor the live state changed.
      expect(yield* stateText(over)).toBe(seed);
      expect((yield* store.read).connectors).toEqual([]);
      const afterRestart = yield* (yield* makeConnectorStateStore(over)).read;
      expect(afterRestart.writable).toBe(true);
      expect(afterRestart.connectors).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.live("keeps a format-1 file whose migrated rewrite would exceed the limit", () =>
    Effect.gen(function* () {
      const {
        authRevision: _authRevision,
        availability: _availability,
        ...legacy
      } = encodeRecord(record);
      // Compact JSON well under the limit; pretty-printing the preserved array
      // (one element per indented line) takes it well past.
      const seed = JSON.stringify({
        formatVersion: 1,
        connectors: [
          { ...legacy, projectPolicy: "all-projects" },
          { numbers: Array(500_000).fill(1) },
        ],
        projectSelections: [],
      });
      expect(Buffer.byteLength(seed)).toBeLessThan(MAX_STATE_BYTES);
      const directory = yield* seededDirectory(seed);

      const store = yield* makeConnectorStateStore(directory);
      const loaded = yield* store.read;
      expect(loaded.writable).toBe(true);
      expect(loaded.connectors).toEqual([record]);
      expect(yield* stateText(directory)).toBe(seed);

      const refused = yield* Effect.flip(
        store.update((current) =>
          Effect.succeed([
            undefined,
            {
              connectors: current.connectors.map((entry) => ({ ...entry, displayName: "Renamed" })),
            },
          ] as const),
        ),
      );
      expect(refused.reason).toBe("limit-reached");
      expect(yield* stateText(directory)).toBe(seed);
      expect((yield* store.read).connectors).toEqual([record]);

      const reloaded = yield* (yield* makeConnectorStateStore(directory)).read;
      expect(reloaded.connectors).toEqual([record]);
      expect(reloaded.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
        "connector-record-unreadable",
      ]);
    }).pipe(Effect.scoped),
  );
});
