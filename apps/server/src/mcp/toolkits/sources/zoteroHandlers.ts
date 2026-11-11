// @effect-diagnostics nodeBuiltinImport:off -- Agent Zotero import operation IDs use the system CSPRNG.
import * as NodeCrypto from "node:crypto";

import {
  zoteroGroupIdOfLibrary,
  zoteroGroupLibraryId,
  type ScientSourceZoteroRefreshField,
  type ZoteroConnection,
  type ZoteroGroup,
  type ZoteroImportScope,
} from "@scientfactory/scient-sources";
import { listScientSourceRecords } from "@scientfactory/scient-sources/store";
import * as Effect from "effect/Effect";

import { makeSourceImportAnalytics } from "../../../telemetry/SourceImportAnalytics.ts";
import {
  advanceSourceImport,
  beginZoteroImport,
  beginZoteroScopedImport,
  inspectZoteroConnection,
  listZoteroCollections,
  listZoteroLibrary,
} from "../../../scient/sources/ScientSourcesCoordinator.ts";
import { zoteroKeyLookup } from "../../../scient/sources/ZoteroAccountKey.ts";
import {
  listZoteroGroups,
  ZoteroTransports,
  type ZoteroAccess,
} from "../../../scient/sources/ZoteroConnections.ts";
import {
  refreshZoteroSources,
  safeZoteroMessage,
  sendSourcesToZotero,
} from "../../../scient/sources/ZoteroSync.ts";
import { ScientSourcesBackend } from "../../../scient/sources/SourcesBackend.ts";
import { resolveScientSourcesProject } from "./handlers.ts";
import { ScientSourcesToolError } from "./tools.ts";

const MAX_COLLECTIONS_SHOWN = 1_000;

const agentGroups = (groups: ReadonlyArray<ZoteroGroup>) =>
  groups.map((group) => ({ id: group.groupId, name: group.name, canWrite: group.canWrite }));

const zoteroAttempt = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) =>
      new ScientSourcesToolError({ code: "operation-failed", message: safeZoteroMessage(cause) }),
  });

/** The project and the Zotero access an agent in it has, following the Accounts switches. */
const agentZotero = Effect.fn("ScientSourcesToolkit.zoteroAccess")(function* () {
  const project = yield* resolveScientSourcesProject();
  // Zotero runs through the durable import operations, which still serve project stores only.
  if ((yield* ScientSourcesBackend) === "library") {
    return yield* new ScientSourcesToolError({
      code: "operation-failed",
      message: "This works with project Sources only for now.",
    });
  }
  const zotero: ZoteroAccess = {
    ...(yield* ZoteroTransports),
    webKey: yield* zoteroKeyLookup({ actor: "agent", projectId: project.projectId }),
  };
  return { root: project.root, zotero };
});

const readyConnection = Effect.fn("ScientSourcesToolkit.zoteroReady")(function* (
  zotero: ZoteroAccess,
  connection: ZoteroConnection | undefined,
) {
  const status = yield* zoteroAttempt(() =>
    inspectZoteroConnection({ zotero, ...(connection ? { connection } : {}) }),
  );
  if (status.state !== "ready") {
    return yield* new ScientSourcesToolError({ code: "operation-failed", message: status.message });
  }
  return status.connection ?? "local";
});

export const browseZoteroForInvocation = Effect.fn("ScientSourcesToolkit.zoteroBrowse")(
  function* (input: {
    readonly connection?: ZoteroConnection;
    readonly library?: string;
    readonly collectionKey?: string;
    readonly includeSubcollections?: boolean;
    readonly query?: string;
    readonly start?: number;
    readonly limit?: number;
  }) {
    const { root, zotero } = yield* agentZotero();
    const status = yield* zoteroAttempt(() =>
      inspectZoteroConnection({
        zotero,
        ...(input.connection ? { connection: input.connection } : {}),
      }),
    );
    if (status.state !== "ready") {
      return {
        state: status.state,
        connection: status.connection ?? null,
        canWrite: false,
        message: status.message,
        groups: [],
        collections: [],
        items: [],
        total: 0,
        nextStart: null,
      };
    }
    const connection = status.connection ?? "local";
    if (status.myLibrary === false && !input.library) {
      const groups = yield* zoteroAttempt(() => listZoteroGroups(zotero, connection));
      return {
        state: status.state,
        connection,
        canWrite: false,
        message:
          "The Zotero key in Accounts cannot read My Library. Pass `library` with a group id from `groups`.",
        groups: agentGroups(groups),
        collections: [],
        items: [],
        total: 0,
        nextStart: null,
      };
    }
    const scope: ZoteroImportScope = input.collectionKey
      ? {
          kind: "collection",
          collectionKey: input.collectionKey,
          includeSubcollections: input.includeSubcollections ?? false,
        }
      : { kind: "library" };
    const library = input.library ? { groupId: input.library } : {};
    const [groups, collections, page, records] = yield* zoteroAttempt(() =>
      Promise.all([
        listZoteroGroups(zotero, connection).catch(() => []),
        listZoteroCollections({ connection, ...library, zotero }),
        listZoteroLibrary({
          scope,
          query: input.query ?? "",
          start: input.start ?? 0,
          limit: Math.min(50, Math.max(1, input.limit ?? 25)),
          connection,
          ...library,
          zotero,
        }),
        listScientSourceRecords(root),
      ]),
    );
    // Item keys repeat across libraries, so a key counts as imported only from its own one.
    const libraryOf = (libraryId: string) =>
      zoteroGroupIdOfLibrary(libraryId) ? libraryId : "user";
    const imported = new Map(
      records.flatMap((record) =>
        record.externalReferences
          .filter((reference) => reference.system === "zotero")
          .map(
            (reference) =>
              [`${libraryOf(reference.libraryId)}\0${reference.itemKey}`, record.sourceId] as const,
          ),
      ),
    );
    const browsed = input.library ? zoteroGroupLibraryId(input.library) : "user";
    return {
      state: status.state,
      connection,
      canWrite: status.canWrite ?? false,
      message: status.message,
      groups: agentGroups(groups),
      collections: collections.collections.slice(0, MAX_COLLECTIONS_SHOWN).map((collection) => ({
        key: collection.key,
        name: collection.name,
        parentKey: collection.parentCollectionKey,
      })),
      items: page.items.map((item) => {
        const creator = item.creators[0];
        return {
          itemKey: item.sourceKey,
          type: item.type,
          title: item.title,
          creator: creator?.familyName ?? creator?.literalName ?? creator?.givenName ?? null,
          issuedYear: item.issuedYear,
          doi: item.identifiers.find((identifier) => identifier.scheme === "doi")?.value ?? null,
          pdfCount: item.pdfAttachmentCount,
          sourceId: imported.get(`${browsed}\0${item.sourceKey}`) ?? null,
        };
      }),
      total: page.total,
      nextStart: page.hasMore ? page.nextStart : null,
    };
  },
);

export const importZoteroForInvocation = Effect.fn("ScientSourcesToolkit.zoteroImport")(
  function* (input: {
    readonly connection?: ZoteroConnection;
    readonly library?: string;
    readonly itemKeys?: ReadonlyArray<string>;
    readonly collectionKey?: string;
    readonly includeSubcollections?: boolean;
    readonly all?: boolean;
    readonly possibleMetadataMatchOverrides?: ReadonlyArray<string>;
  }) {
    const choices = [
      input.itemKeys !== undefined,
      input.collectionKey !== undefined,
      input.all === true,
    ];
    if (choices.filter(Boolean).length !== 1) {
      return yield* new ScientSourcesToolError({
        code: "operation-failed",
        message: "Pass exactly one of itemKeys, collectionKey or all.",
      });
    }
    const { root, zotero } = yield* agentZotero();
    const connection = yield* readyConnection(zotero, input.connection);
    const operationId = `agent_zotero_${NodeCrypto.randomUUID()}`;
    const itemKeys = input.itemKeys;
    const library = input.library ? { groupId: input.library } : {};
    yield* zoteroAttempt(() =>
      itemKeys
        ? beginZoteroImport({
            root,
            operationId,
            itemKeys,
            possibleMetadataMatchOverrides: (input.possibleMetadataMatchOverrides ?? []).filter(
              (key) => itemKeys.includes(key),
            ),
            connection,
            ...library,
            actor: "agent",
          })
        : beginZoteroScopedImport({
            root,
            operationId,
            scope: input.collectionKey
              ? {
                  kind: "collection",
                  collectionKey: input.collectionKey,
                  includeSubcollections: input.includeSubcollections ?? false,
                }
              : { kind: "library" },
            connection,
            ...library,
            actor: "agent",
            zotero,
          }),
    );
    const observeImport = yield* makeSourceImportAnalytics("agent");
    const operation = yield* zoteroAttempt(async () => {
      let current = await advanceSourceImport({ root, operationId, zotero }, observeImport);
      for (let step = 0; step <= current.items.length; step += 1) {
        if (
          current.state !== "running" ||
          !current.items.some((item) => item.state === "pending")
        ) {
          break;
        }
        current = await advanceSourceImport({ root, operationId, zotero }, observeImport);
      }
      return current;
    });
    const count = (state: string) => operation.items.filter((item) => item.state === state).length;
    return {
      imported: count("imported"),
      skipped: count("skipped"),
      failed: count("failed"),
      items: operation.items.map((item) => ({
        itemKey: item.itemKey,
        outcome: item.state,
        ...(item.duplicateKind ? { duplicate: item.duplicateKind } : {}),
        sourceId: item.sourceId,
        message:
          item.state === "failed" ? safeZoteroMessage(new Error(item.message ?? "")) : item.message,
        ...(item.note ? { note: item.note } : {}),
      })),
    };
  },
);

export const refreshZoteroForInvocation = Effect.fn("ScientSourcesToolkit.zoteroRefresh")(
  function* (input: {
    readonly sourceIds?: ReadonlyArray<string>;
    readonly connection?: ZoteroConnection;
    readonly useZotero?: ReadonlyArray<ScientSourceZoteroRefreshField>;
    readonly keepLocal?: ReadonlyArray<ScientSourceZoteroRefreshField>;
  }) {
    const { root, zotero } = yield* agentZotero();
    const result = yield* zoteroAttempt(() =>
      refreshZoteroSources({
        root,
        ...(input.sourceIds ? { sourceIds: input.sourceIds } : {}),
        ...(input.connection ? { connection: input.connection } : {}),
        choices: {
          useZotero: new Set(input.useZotero ?? []),
          keepLocal: new Set(input.keepLocal ?? []),
        },
        actor: "agent",
        zotero,
      }),
    );
    const listed = result.items.filter(
      (item) => item.outcome !== "unchanged" || item.conflicts.length > 0,
    );
    return {
      connection: result.connection,
      unchanged: result.items.length - listed.length,
      items: listed,
    };
  },
);

export const sendToZoteroForInvocation = Effect.fn("ScientSourcesToolkit.zoteroSend")(
  function* (input: { readonly sourceIds: ReadonlyArray<string>; readonly library?: string }) {
    const { root, zotero } = yield* agentZotero();
    return yield* zoteroAttempt(() =>
      sendSourcesToZotero({
        root,
        sourceIds: input.sourceIds,
        ...(input.library ? { groupId: input.library } : {}),
        actor: "agent",
        zotero,
      }),
    );
  },
);
