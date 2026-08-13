import {
  listScientSourceRecords,
  readScientSourceRecord,
  updateScientSourceNote,
} from "@scientfactory/scient-sources/store";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { ScientSourcesToolError, ScientSourcesToolkit } from "./tools.ts";

type ErrorCode = ConstructorParameters<typeof ScientSourcesToolError>[0]["code"];

const toolError = (code: ErrorCode, message: string) =>
  new ScientSourcesToolError({ code, message });

const attempt = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    // Store and filesystem errors can contain an absolute project path. MCP
    // results deliberately keep that host-only context out of model-visible
    // output.
    catch: () => toolError("operation-failed", "The Sources operation could not be completed."),
  });

export const resolveScientSourcesProject = Effect.fn("ScientSourcesToolkit.resolveProject")(
  function* () {
    const invocation = yield* McpInvocationContext.McpInvocationContext;
    if (!invocation.capabilities.has("sources:read")) {
      return yield* toolError(
        "capability-unavailable",
        "This provider session does not grant Sources access.",
      );
    }
    const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
    const thread = yield* snapshots
      .getThreadShellById(invocation.threadId)
      .pipe(
        Effect.mapError(() =>
          toolError("operation-failed", "The current thread could not be resolved."),
        ),
      );
    if (Option.isNone(thread) || thread.value.projectId === null) {
      return yield* toolError(
        "project-required",
        "Sources tools require a thread that belongs to a Scient project.",
      );
    }
    const project = yield* snapshots
      .getProjectShellById(thread.value.projectId)
      .pipe(
        Effect.mapError(() =>
          toolError("operation-failed", "The current project could not be resolved."),
        ),
      );
    if (Option.isNone(project)) {
      return yield* toolError(
        "project-changed",
        "The project for this thread is no longer active.",
      );
    }
    return {
      projectId: thread.value.projectId,
      root: thread.value.worktreePath ?? project.value.workspaceRoot,
    };
  },
);

const creatorName = (record: Awaited<ReturnType<typeof listScientSourceRecords>>[number]) => {
  const creator = record.creators[0];
  return creator?.familyName ?? creator?.literalName ?? creator?.givenName ?? null;
};

const doiValue = (record: Awaited<ReturnType<typeof listScientSourceRecords>>[number]) =>
  record.identifiers.find((identifier) => identifier.scheme.toLowerCase() === "doi")?.value ?? null;

export const listScientSourcesForInvocation = Effect.fn("ScientSourcesToolkit.list")(
  function* (input: {
    readonly query?: string;
    readonly offset?: number;
    readonly limit?: number;
  }) {
    const { root } = yield* resolveScientSourcesProject();
    const all = yield* attempt(() => listScientSourceRecords(root));
    const query = input.query?.trim().toLowerCase() ?? "";
    const matching =
      query.length === 0
        ? all
        : all.filter((record) =>
            [
              record.title,
              creatorName(record),
              record.issuedYear,
              record.containerTitle,
              doiValue(record),
            ]
              .filter((value) => value !== null)
              .join(" ")
              .toLowerCase()
              .includes(query),
          );
    // The public schema rejects invalid values. Clamp here as a second
    // boundary so internal callers cannot accidentally create an unbounded
    // model payload by bypassing MCP decoding.
    const offset = Math.max(0, input.offset ?? 0);
    const limit = Math.min(50, Math.max(1, input.limit ?? 25));
    const page = matching.slice(offset, offset + limit);
    return {
      records: page.map((record) => ({
        sourceId: record.sourceId,
        revision: record.revision,
        type: record.type,
        title: record.title,
        creator: creatorName(record),
        issuedYear: record.issuedYear,
        containerTitle: record.containerTitle,
        doi: doiValue(record),
        hasPdf: record.attachments.some((attachment) => attachment.kind === "pdf"),
      })),
      total: matching.length,
      nextOffset: offset + page.length < matching.length ? offset + page.length : null,
    };
  },
);

export const getScientSourceForInvocation = Effect.fn("ScientSourcesToolkit.get")(
  function* (input: { readonly sourceId: string }) {
    const { root } = yield* resolveScientSourcesProject();
    const record = yield* attempt(() => readScientSourceRecord(root, input.sourceId));
    if (!record) return yield* toolError("not-found", "The source was not found in this project.");
    const maximumAbstractCharacters = 50_000;
    const abstract = record.abstract;
    const abstractTruncated = abstract !== null && abstract.length > maximumAbstractCharacters;
    return {
      ...record,
      abstract: abstractTruncated ? abstract.slice(0, maximumAbstractCharacters) : abstract,
      abstractTruncated,
      note: record.note ?? null,
      attachments: record.attachments.map(
        ({ attachmentId, kind, fileName, mediaType, sha256, byteLength, importedAt }) => ({
          attachmentId,
          kind,
          fileName,
          mediaType,
          sha256,
          byteLength,
          importedAt,
        }),
      ),
    };
  },
);

export const updateScientSourceNoteForInvocation = Effect.fn("ScientSourcesToolkit.updateNote")(
  function* (input: {
    readonly sourceId: string;
    readonly expectedRevision: number;
    readonly note: string | null;
  }) {
    const { root } = yield* resolveScientSourcesProject();
    const current = yield* attempt(() => readScientSourceRecord(root, input.sourceId));
    if (!current) return yield* toolError("not-found", "The source was not found in this project.");
    const result = yield* attempt(() =>
      updateScientSourceNote({
        root,
        sourceId: input.sourceId,
        expectedRevision: input.expectedRevision,
        note: input.note,
      }),
    );
    return {
      outcome: result.outcome,
      sourceId: result.record.sourceId,
      revision: result.record.revision,
      note: result.record.note ?? null,
    };
  },
);

const handlers = {
  scient_sources_list: listScientSourcesForInvocation,
  scient_sources_get: getScientSourceForInvocation,
  scient_sources_note_update: updateScientSourceNoteForInvocation,
} satisfies Parameters<typeof ScientSourcesToolkit.toLayer>[0];

export const ScientSourcesToolkitHandlersLive = ScientSourcesToolkit.toLayer(handlers);
