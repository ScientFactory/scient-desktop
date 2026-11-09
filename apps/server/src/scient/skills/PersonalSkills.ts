// @effect-diagnostics nodeBuiltinImport:off -- Personal skills are plain folders on this computer.
/**
 * Personal skills: skills the user added, or an agent saved for them, kept as mutable folders in
 * Scient's skills folder and published into the skill catalog next to Scient's own and plugins'.
 * Every save keeps the earlier version so the last change can be undone.
 *
 * @module PersonalSkills
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  loadPersonalSkillCatalog,
  MAX_PERSONAL_SKILL_BYTES,
  MAX_PERSONAL_SKILLS,
  personalSkillReleaseFromFiles,
  prepareSkillDocument,
  SKILL_DOCUMENT_FILE,
  toSkillReleaseRef,
} from "@scientfactory/scient-skills";
import {
  type ImportableSkill,
  type PersonalSkillDetails,
  type PersonalSkillInspection,
  type PersonalSkillSource,
  ScientSkillManagementError,
  type ScientSkillInventoryDiagnostic,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { HttpClient } from "effect/http";
import * as yazl from "yazl";

import * as ServerConfig from "../../config.ts";
import {
  latestHistory,
  folderSignature,
  skillsFolderUsage,
  readSkillFolder,
  removeSkillFolder,
  restoreSkillFolder,
  SkillFolderError,
  writeSkillFolder,
} from "./PersonalSkillFiles.ts";
import {
  fromPath,
  fromText,
  fromUrl,
  type SkillSourceRecord,
  type StagedCandidate,
} from "./PersonalSkillSources.ts";
import * as ScientSkillPolicy from "./ScientSkillPolicy.ts";
import * as ScientSkillRegistry from "./ScientSkillRegistry.ts";

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

/** A folder directly inside the skills folder, never a path out of it. */
const isSkillFolderName = (name: string) =>
  name.length > 0 &&
  name.length <= 255 &&
  !name.startsWith(".") &&
  !/[\\/]/u.test(name) &&
  name !== "..";
const STAGING_TTL_MS = 60 * 60 * 1000;
const MAX_STAGED = 20;
/** Material an agent finishes from stays this long, so a chat can still read it. */
const DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface SavedSkillFile {
  readonly path: string;
  readonly encoding: "utf8" | "base64";
  readonly content: string;
}

export interface PersonalSkillsShape {
  /** Re-read the skills folder when it changed and publish it to the catalog. */
  readonly refresh: Effect.Effect<void>;
  /** Folder, source and Undo state per skill name, and problems with broken folders. */
  readonly details: Effect.Effect<{
    readonly byName: ReadonlyMap<string, PersonalSkillDetails>;
    readonly diagnostics: ReadonlyArray<ScientSkillInventoryDiagnostic>;
  }>;
  readonly inspect: (
    source: PersonalSkillSource,
  ) => Effect.Effect<PersonalSkillInspection, ScientSkillManagementError>;
  readonly add: (input: {
    readonly stagingId: string;
    readonly keys: ReadonlyArray<string>;
  }) => Effect.Effect<ReadonlyArray<string>, ScientSkillManagementError>;
  /** An agent saves a skill's files for the user. It is checked like any skill. */
  readonly save: (input: {
    readonly name: string;
    readonly files: Readonly<Record<string, string>>;
  }) => Effect.Effect<
    {
      readonly created: boolean;
      readonly active: boolean;
      /** Saved, but withheld: a Scient or plugin skill took the name meanwhile. */
      readonly withheld?: string;
    },
    ScientSkillManagementError
  >;
  readonly read: (
    name: string,
  ) => Effect.Effect<ReadonlyArray<SavedSkillFile>, ScientSkillManagementError>;
  readonly remove: (name: string) => Effect.Effect<void, ScientSkillManagementError>;
  readonly undo: (name: string) => Effect.Effect<void, ScientSkillManagementError>;
  readonly exportZip: (
    name: string,
  ) => Effect.Effect<
    { readonly fileName: string; readonly base64: string },
    ScientSkillManagementError
  >;
  readonly importables: Effect.Effect<ReadonlyArray<ImportableSkill>>;
}

const unavailable = (operation: string) =>
  Effect.fail(
    new ScientSkillManagementError({
      operation,
      message: "Personal skills are unavailable in this server composition.",
    }),
  );

const inert: PersonalSkillsShape = {
  refresh: Effect.void,
  details: Effect.succeed({ byName: new Map(), diagnostics: [] }),
  inspect: () => unavailable("inspect"),
  add: () => unavailable("add"),
  save: () => unavailable("save"),
  read: () => unavailable("read"),
  remove: () => unavailable("remove"),
  undo: () => unavailable("undo"),
  exportZip: () => unavailable("export"),
  importables: Effect.succeed([]),
};

/** Inert by default, so generic server and test compositions keep no personal skills. */
export class PersonalSkills extends Context.Reference<PersonalSkillsShape>(
  "t3/scient/skills/PersonalSkills",
  { defaultValue: () => inert },
) {}

const SourceEntry = Schema.Struct({
  source: Schema.optional(Schema.String),
  updatedAt: Schema.String,
  changedBy: Schema.Literals(["you", "agent"]),
});
const SourcesFile = Schema.Record(Schema.String, SourceEntry);
const decodeSources = Schema.decodeUnknownExit(Schema.fromJsonString(SourcesFile));
const encodeSources = Schema.encodeExit(Schema.fromJsonString(SourcesFile));

/** A sortable time for history entry names. */
const historyStamp = Effect.map(DateTime.now, (now) =>
  DateTime.formatIso(now).replace(/[:.]/gu, "-"),
);
type SourcesFile = typeof SourcesFile.Type;

interface Staged {
  readonly createdAt: number;
  readonly source: SkillSourceRecord;
  readonly candidates: ReadonlyMap<string, StagedCandidate>;
}

const managementError = (operation: string, message: string) =>
  new ScientSkillManagementError({ operation, message });

const messageOf = (cause: unknown, fallback: string) =>
  cause instanceof SkillFolderError ||
  (cause instanceof Error && cause.name === "SkillReleaseValidationError")
    ? cause.message
    : cause instanceof Error && cause.name === "SkillDocumentError"
      ? cause.message
      : fallback;

const zipFolder = (name: string, files: Readonly<Record<string, Uint8Array>>) =>
  new Promise<Buffer>((resolve, reject) => {
    const zip = new yazl.ZipFile();
    const chunks: Buffer[] = [];
    zip.outputStream.on("data", (chunk: Buffer) => chunks.push(chunk));
    zip.outputStream.on("error", reject);
    zip.outputStream.on("end", () => resolve(Buffer.concat(chunks)));
    for (const [path, bytes] of Object.entries(files)) {
      zip.addBuffer(Buffer.from(bytes), `${name}/${path}`, { mode: 0o100644 });
    }
    zip.end();
  });

const make = Effect.fn("PersonalSkills.make")(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const registry = yield* ScientSkillRegistry.ScientSkillRegistry;
  const policy = yield* ScientSkillPolicy.ScientSkillPolicy;
  const http = yield* HttpClient.HttpClient;
  // Other agents' folders are found from the home folder and environment Scient started with.
  const home = yield* HostProcess.HomeDirectory;
  const env = yield* HostProcess.Environment;
  const root = NodePath.join(config.stateDir, "skills");
  const historyRoot = NodePath.join(config.stateDir, "skill-history");
  const draftsRoot = NodePath.join(config.stateDir, "skill-drafts");
  const sourcesPath = NodePath.join(config.stateDir, "personal-skills.json");
  // Reading the folder and changing it take turns, so a turn never sees a skill mid-save.
  const lock = yield* Semaphore.make(1);
  const serial = <A, E, R>(effect: Effect.Effect<A, E, R>) => lock.withPermits(1)(effect);
  const signature = yield* Ref.make<string | undefined>(undefined);
  const catalogDiagnostics = yield* Ref.make<ReadonlyArray<ScientSkillInventoryDiagnostic>>([]);
  const staged = new Map<string, Staged>();

  // Material for agents is kept a week; older drafts are cleared at start.
  const startedAt = yield* Clock.currentTimeMillis;
  yield* Effect.promise(async () => {
    const entries = await NodeFSP.readdir(draftsRoot).catch(() => [] as string[]);
    for (const entry of entries) {
      const folder = NodePath.join(draftsRoot, entry);
      const stat = await NodeFSP.stat(folder).catch(() => null);
      if (stat && startedAt - stat.mtimeMs > DRAFT_TTL_MS) {
        await NodeFSP.rm(folder, { recursive: true, force: true });
      }
    }
  });

  const readSources = Effect.promise(async (): Promise<SourcesFile> => {
    const text = await NodeFSP.readFile(sourcesPath, "utf8").catch(() => undefined);
    if (text === undefined) return {};
    const decoded = decodeSources(text);
    return decoded._tag === "Success" ? decoded.value : {};
  });

  const writeSources = (next: SourcesFile) => {
    const encoded = encodeSources(next);
    if (encoded._tag === "Failure") return Effect.void;
    return Effect.promise(async () => {
      const temporary = `${sourcesPath}.${NodeCrypto.randomBytes(4).toString("hex")}.tmp`;
      await NodeFSP.mkdir(NodePath.dirname(sourcesPath), { recursive: true });
      await NodeFSP.writeFile(temporary, `${encoded.value}\n`);
      await NodeFSP.rename(temporary, sourcesPath);
    });
  };

  const publish = Effect.gen(function* () {
    const catalog = yield* Effect.promise(() => loadPersonalSkillCatalog(root));
    yield* registry.replacePersonalReleases(catalog.releases);
    yield* Ref.set(
      catalogDiagnostics,
      catalog.diagnostics.map((diagnostic) => ({
        code:
          diagnostic.code === "invalid-skill" ? "personal-skill-invalid" : "personal-skill-limit",
        message: diagnostic.message,
        path: diagnostic.path ? NodePath.join(root, diagnostic.path) : root,
      })),
    );
  });

  /** Publish again only when the folder changed on disk, since it is read on every turn. */
  const refreshHeld = Effect.gen(function* () {
    const next = yield* Effect.promise(() => folderSignature(root));
    if ((yield* Ref.get(signature)) === next) return;
    yield* publish;
    yield* Ref.set(signature, next);
  });
  const refresh = serial(refreshHeld);
  /** After a change made while holding the lock. */
  const republishHeld = Effect.gen(function* () {
    yield* Ref.set(signature, undefined);
    yield* refreshHeld;
  });

  /** Published personal skills: the ones whose names Scient and plugins leave free. */
  const published = Effect.map(registry.current, (view) =>
    view.catalog.releases.filter((release) => release.origin === "personal"),
  );

  const releaseNamed = (name: string) =>
    Effect.map(published, (all) => all.find((release) => release.name === name));

  const takenByOthers = Effect.gen(function* () {
    const view = yield* registry.current;
    return new Set(
      view.catalog.releases
        .filter((release) => release.origin !== "personal")
        .map((release) => release.name.toLowerCase()),
    );
  });

  const details: PersonalSkillsShape["details"] = Effect.gen(function* () {
    yield* refresh;
    const sources = yield* readSources;
    const all = yield* published;
    const byName = new Map<string, PersonalSkillDetails>();
    for (const release of all) {
      const entry = sources[release.name];
      const canUndo =
        (yield* Effect.promise(() => latestHistory(historyRoot, release.name))) !== undefined;
      byName.set(release.name, {
        folder: NodePath.join(root, release.name),
        ...(entry?.source ? { source: entry.source } : {}),
        ...(entry ? { updatedAt: entry.updatedAt, changedBy: entry.changedBy } : {}),
        canUndo,
      });
    }
    const withheld = yield* registry.personalRejections;
    return {
      byName,
      diagnostics: [
        ...(yield* Ref.get(catalogDiagnostics)),
        ...withheld.map((rejection) => ({
          code: "personal-skill-collision",
          message: rejection.message,
          path: NodePath.join(root, rejection.name),
        })),
      ],
    };
  });

  /** Write a skill, note where it came from, publish it, and turn a new one on. */
  const store = Effect.fn("PersonalSkills.store")(function* (input: {
    readonly name: string;
    readonly files: Readonly<Record<string, Uint8Array>>;
    readonly source: string | undefined;
    readonly changedBy: "you" | "agent";
  }) {
    const release = yield* Effect.try({
      try: () => personalSkillReleaseFromFiles(input.name, input.files),
      catch: (cause) => managementError("save", messageOf(cause, "That is not a valid skill.")),
    });
    if ((yield* takenByOthers).has(input.name.toLowerCase())) {
      return yield* managementError(
        "save",
        `A skill built into Scient or a plugin is already named '${input.name}'. Choose another name.`,
      );
    }
    // Limits are checked on the folder as it is now, before anything is written, so a save
    // never pushes another skill out.
    const usage = yield* Effect.promise(() => skillsFolderUsage(root, input.name));
    if (usage.count >= MAX_PERSONAL_SKILLS) {
      return yield* managementError(
        "save",
        `You have ${MAX_PERSONAL_SKILLS} skills, the most Scient keeps. Remove one first.`,
      );
    }
    if (usage.bytes + release.snapshotBytes > MAX_PERSONAL_SKILL_BYTES) {
      return yield* managementError(
        "save",
        "Your skills would pass the 100 MiB Scient keeps. Remove one or make this one smaller.",
      );
    }
    const stamp = yield* historyStamp;
    const { created } = yield* Effect.tryPromise({
      try: () =>
        writeSkillFolder({ root, historyRoot, name: input.name, files: input.files, stamp }),
      catch: (cause) =>
        managementError("save", messageOf(cause, "Scient could not save the skill.")),
    });
    const sources = yield* readSources;
    const previous = sources[input.name];
    const source = input.source ?? previous?.source;
    yield* writeSources({
      ...sources,
      [input.name]: {
        ...(source ? { source } : {}),
        updatedAt: DateTime.formatIso(yield* DateTime.now),
        changedBy: input.changedBy,
      },
    });
    yield* republishHeld;
    // A new skill is on; an edited one keeps the user's choice.
    if (created) {
      yield* policy
        .setUserSkillActivation(toSkillReleaseRef(release), true, release.defaultInvocationPolicy)
        .pipe(Effect.ignore);
    }
    const withheld = (yield* registry.personalRejections).find(
      (rejection) => rejection.name === input.name,
    );
    const snapshot = yield* policy.snapshot;
    const choice = snapshot.userSkills.find(
      (entry) => entry.release.origin === "personal" && entry.release.id === release.id,
    );
    return {
      created,
      active: withheld === undefined && (choice?.active ?? true),
      ...(withheld ? { withheld: withheld.message } : {}),
    };
  }, serial);

  const sweepStaged = (now: number) => {
    for (const [id, entry] of staged) {
      if (now - entry.createdAt > STAGING_TTL_MS) staged.delete(id);
    }
    while (staged.size >= MAX_STAGED) {
      const oldest = staged.keys().next().value;
      if (oldest === undefined) break;
      staged.delete(oldest);
    }
  };

  const inspect: PersonalSkillsShape["inspect"] = Effect.fn("PersonalSkills.inspect")(
    function* (source) {
      const stagingId = NodeCrypto.randomUUID();
      const work = NodePath.join(draftsRoot, stagingId);
      const result = yield* (
        source.type === "path"
          ? fromPath(source.path, work)
          : source.type === "url"
            ? fromUrl(source.url, work)
            : fromText(source.text, source.name, work)
      ).pipe(Effect.provideService(HttpClient.HttpClient, http));
      if (result.kind === "none") {
        yield* Effect.promise(() => NodeFSP.rm(work, { recursive: true, force: true }));
        return { kind: "none" } as const;
      }
      const now = yield* Clock.currentTimeMillis;
      sweepStaged(now);
      staged.set(stagingId, {
        createdAt: now,
        source: result.source,
        candidates: new Map(result.candidates.map((candidate) => [candidate.key, candidate])),
      });
      const existing = new Set((yield* published).map((release) => release.name));
      const others = yield* takenByOthers;
      return {
        kind: "skills",
        stagingId,
        sourceLabel: result.source.label,
        candidates: result.candidates.map((candidate) => ({
          key: candidate.key,
          ...(candidate.name ? { name: candidate.name } : {}),
          ...(candidate.description ? { description: candidate.description } : {}),
          status: candidate.status,
          ...(candidate.reason ? { reason: candidate.reason } : {}),
          notes: [...candidate.notes],
          exists: candidate.name !== undefined && existing.has(candidate.name),
          ...(candidate.name && others.has(candidate.name.toLowerCase())
            ? {
                conflict: `A skill built into Scient or a plugin is already named '${candidate.name}'.`,
              }
            : {}),
          ...(candidate.material ? { material: candidate.material } : {}),
        })),
      } satisfies PersonalSkillInspection;
    },
  );

  const add: PersonalSkillsShape["add"] = Effect.fn("PersonalSkills.add")(function* (input) {
    const entry = staged.get(input.stagingId);
    if (entry === undefined) {
      return yield* managementError("add", "That expired. Choose the file or address again.");
    }
    const added: string[] = [];
    for (const key of input.keys) {
      const candidate = entry.candidates.get(key);
      if (candidate?.status !== "ready" || !candidate.name || !candidate.files) {
        return yield* managementError("add", "That skill needs an agent to finish it first.");
      }
      yield* store({
        name: candidate.name,
        files: candidate.files,
        source: entry.source.label,
        changedBy: "you",
      });
      added.push(candidate.name);
    }
    return added;
  });

  const save: PersonalSkillsShape["save"] = Effect.fn("PersonalSkills.save")(function* (input) {
    if (!SKILL_NAME.test(input.name) || input.name.length > 64) {
      return yield* managementError(
        "save",
        "A skill name is lowercase words joined by hyphens, at most 64 characters.",
      );
    }
    const document = input.files[SKILL_DOCUMENT_FILE];
    if (document === undefined) {
      return yield* managementError("save", "Include SKILL.md.");
    }
    const draft = prepareSkillDocument(document, input.name);
    if (draft.status === "needs-agent") return yield* managementError("save", draft.reason);
    if (draft.name !== input.name) {
      return yield* managementError(
        "save",
        `SKILL.md is named '${draft.name}'; set its name to '${input.name}' or save it under that name.`,
      );
    }
    const encoder = new TextEncoder();
    const files = Object.fromEntries(
      Object.entries(input.files).map(([path, text]) => [path, encoder.encode(text)]),
    );
    return yield* store({ name: input.name, files, source: undefined, changedBy: "agent" });
  });

  const requireSkill = Effect.fn("PersonalSkills.requireSkill")(function* (
    operation: string,
    name: string,
  ) {
    yield* refresh;
    const release = yield* releaseNamed(name);
    if (release === undefined) {
      return yield* managementError(operation, `You have no skill named '${name}'.`);
    }
    return release;
  });

  const read: PersonalSkillsShape["read"] = Effect.fn("PersonalSkills.read")(function* (name) {
    yield* requireSkill("read", name);
    const { files } = yield* Effect.tryPromise({
      try: () => readSkillFolder(NodePath.join(root, name)),
      catch: (cause) => managementError("read", messageOf(cause, "That skill could not be read.")),
    });
    return Object.entries(files).map(([path, bytes]): SavedSkillFile => {
      try {
        return {
          path,
          encoding: "utf8",
          content: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        };
      } catch {
        return { path, encoding: "base64", content: Buffer.from(bytes).toString("base64") };
      }
    });
  });

  const remove: PersonalSkillsShape["remove"] = Effect.fn("PersonalSkills.remove")(function* (
    name,
  ) {
    // A broken folder can be removed too, so it is checked by name, not as a skill.
    if (!isSkillFolderName(name)) {
      return yield* managementError("remove", "That is not one of your skills.");
    }
    const stamp = yield* historyStamp;
    yield* Effect.tryPromise({
      try: () => removeSkillFolder({ root, historyRoot, name, stamp }),
      catch: (cause) => managementError("remove", messageOf(cause, "Scient could not remove it.")),
    });
    yield* republishHeld;
  }, serial);

  const undo: PersonalSkillsShape["undo"] = Effect.fn("PersonalSkills.undo")(function* (name) {
    if (!isSkillFolderName(name)) {
      return yield* managementError("undo", "That is not one of your skills.");
    }
    yield* Effect.tryPromise({
      try: () => restoreSkillFolder({ root, historyRoot, name }),
      catch: (cause) => managementError("undo", messageOf(cause, "Scient could not undo it.")),
    });
    yield* republishHeld;
  }, serial);

  const exportZip: PersonalSkillsShape["exportZip"] = Effect.fn("PersonalSkills.export")(
    function* (name) {
      yield* requireSkill("export", name);
      const bytes = yield* Effect.tryPromise({
        try: async () => zipFolder(name, (await readSkillFolder(NodePath.join(root, name))).files),
        catch: (cause) =>
          managementError("export", messageOf(cause, "Scient could not export it.")),
      });
      return { fileName: `${name}.zip`, base64: bytes.toString("base64") };
    },
  );

  const importables: PersonalSkillsShape["importables"] = Effect.gen(function* () {
    const places: ReadonlyArray<readonly [ImportableSkill["app"], string, string]> = [
      [
        "claude",
        "Claude Code",
        NodePath.join(env.CLAUDE_CONFIG_DIR ?? NodePath.join(home, ".claude"), "skills"),
      ],
      ["codex", "Codex", NodePath.join(env.CODEX_HOME ?? NodePath.join(home, ".codex"), "skills")],
      ["cursor", "Cursor", NodePath.join(home, ".cursor", "skills")],
      ["agents", "Other agents", NodePath.join(home, ".agents", "skills")],
    ];
    const mine = new Set((yield* published).map((release) => release.name));
    return yield* Effect.promise(async () => {
      const found: ImportableSkill[] = [];
      for (const [app, appLabel, folder] of places) {
        const entries = await NodeFSP.readdir(folder, { withFileTypes: true }).catch(() => []);
        for (const entry of entries) {
          if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
          const skillFolder = NodePath.join(folder, entry.name);
          const text = await NodeFSP.readFile(
            NodePath.join(skillFolder, SKILL_DOCUMENT_FILE),
            "utf8",
          ).catch(() => undefined);
          if (text === undefined) continue;
          const draft = prepareSkillDocument(text, entry.name);
          const name = draft.name ?? entry.name;
          found.push({
            app,
            appLabel,
            name,
            ...(draft.status === "ready" ? { description: draft.description } : {}),
            folder: skillFolder,
            added: mine.has(name),
          });
        }
      }
      return found;
    });
  });

  yield* serial(republishHeld);

  return PersonalSkills.of({
    refresh,
    details,
    inspect,
    add,
    save,
    read,
    remove,
    undo,
    exportZip,
    importables,
  });
});

export const layer = Layer.effect(PersonalSkills, make());
