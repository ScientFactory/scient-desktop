// @effect-diagnostics nodeBuiltinImport:off -- Reads skills the user points at: files, folders, archives and downloads.
/**
 * Turns whatever the user gives into skill candidates: a skill folder, a folder or archive with
 * several skills, a `SKILL.md`, a Markdown or text file, a web address, or pasted text. A
 * candidate is ready (Scient can save it, after fixing a name) or needs an agent to finish it.
 *
 * @module PersonalSkillSources
 */
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeStreamPromises from "node:stream/promises";

import {
  personalSkillReleaseFromFiles,
  prepareSkillDocument,
  SKILL_DOCUMENT_FILE,
  skillNameFrom,
} from "@scientfactory/scient-skills";
import { type PersonalSkillFailure, ScientSkillManagementError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest } from "effect/http";

import { openZipArchive } from "../../zipArchive.ts";
import {
  findSkillFolders,
  materialFiles,
  readSkillFolder,
  SkillFolderError,
} from "./PersonalSkillFiles.ts";

const MAX_ARCHIVE_BYTES = 50 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 5_000;
const MAX_TEXT_BYTES = 1024 * 1024;
/** Material this small is put in the agent's first message; larger material is linked. */
const INLINE_MATERIAL_BYTES = 8 * 1024;
const TEXT_FILE = /\.(md|markdown|txt)$/iu;
const ARCHIVE_FILE = /\.(zip|skill)$/iu;

export type SkillSourceRecord =
  | { readonly kind: "file"; readonly label: string }
  | {
      readonly kind: "url";
      readonly label: string;
      /** Set when the download came from a public code host; see `publicSkillAddress`. */
      readonly publicAddress?: string;
    }
  | { readonly kind: "text"; readonly label: string };

export interface StagedCandidate {
  readonly key: string;
  readonly name?: string;
  readonly description?: string;
  readonly status: "ready" | "needs-agent";
  readonly reason?: string;
  readonly notes: ReadonlyArray<string>;
  /** A ready skill's files, SKILL.md as it will be saved. */
  readonly files?: Readonly<Record<string, Uint8Array>>;
  /** What an agent finishes from: a file or folder, and the text itself when it is short. */
  readonly material?: { readonly path: string; readonly text?: string };
}

export type SkillSourceResult =
  | { readonly kind: "none" }
  | {
      readonly kind: "skills";
      readonly source: SkillSourceRecord;
      readonly candidates: ReadonlyArray<StagedCandidate>;
    };

const sourceError = (message: string, reason: PersonalSkillFailure) =>
  new ScientSkillManagementError({ operation: "inspect", message, reason });

const NONE: SkillSourceResult = { kind: "none" };

const decode = (bytes: Uint8Array) => new TextDecoder("utf-8").decode(bytes);

/** A single document: ready once Scient can fix it, otherwise material for an agent. */
const fromDocument = (input: {
  readonly key: string;
  readonly contents: string;
  readonly fallbackName: string;
  readonly materialPath: string;
}): StagedCandidate => {
  const draft = prepareSkillDocument(input.contents, input.fallbackName);
  const bytes = Buffer.byteLength(input.contents, "utf8");
  if (draft.status === "ready") {
    return {
      key: input.key,
      name: draft.name,
      description: draft.description,
      status: "ready",
      notes: draft.notes,
      files: { [SKILL_DOCUMENT_FILE]: new TextEncoder().encode(draft.contents) },
      // Kept for an agent, should the name be taken.
      material: {
        path: input.materialPath,
        ...(bytes <= INLINE_MATERIAL_BYTES ? { text: draft.contents } : {}),
      },
    };
  }
  return {
    key: input.key,
    ...(draft.name ? { name: draft.name } : {}),
    status: "needs-agent",
    reason: draft.reason,
    notes: [],
    material: {
      path: input.materialPath,
      ...(bytes <= INLINE_MATERIAL_BYTES ? { text: input.contents } : {}),
    },
  };
};

/** One skill folder: its files with SKILL.md fixed, checked like a saved skill would be. */
const fromSkillFolder = (key: string, folder: string) =>
  Effect.tryPromise({
    try: async (): Promise<StagedCandidate> => {
      const { files, notes } = await readSkillFolder(folder);
      const document = files[SKILL_DOCUMENT_FILE];
      const contents = document === undefined ? "" : decode(document);
      const draft = prepareSkillDocument(contents, NodePath.basename(folder));
      if (draft.status === "needs-agent") {
        return {
          key,
          ...(draft.name ? { name: draft.name } : {}),
          status: "needs-agent",
          reason: draft.reason,
          notes,
          material: { path: folder },
        };
      }
      const fixed = { ...files, [SKILL_DOCUMENT_FILE]: new TextEncoder().encode(draft.contents) };
      try {
        personalSkillReleaseFromFiles(draft.name, fixed);
      } catch (error) {
        return {
          key,
          name: draft.name,
          status: "needs-agent",
          reason: error instanceof Error ? error.message : "It is not a valid skill yet.",
          notes,
          material: { path: folder },
        };
      }
      return {
        key,
        name: draft.name,
        description: draft.description,
        status: "ready",
        notes: [...draft.notes, ...notes],
        files: fixed,
        material: { path: folder },
      };
    },
    catch: (cause) =>
      sourceError(
        `${NodePath.basename(folder)}: ${cause instanceof Error ? cause.message : "it could not be read."}`,
        cause instanceof SkillFolderError ? cause.reason : "unreadable",
      ),
  });

/**
 * A folder: the skills in it, else its Markdown or text notes as material. Folders that are
 * connectors or plugins are left to the connector path.
 */
const fromFolder = Effect.fn("PersonalSkillSources.fromFolder")(function* (folder: string) {
  // A Scient plugin brings its skills and connectors together; the plugin installer owns it.
  const isPlugin = yield* Effect.promise(() =>
    NodeFSP.lstat(NodePath.join(folder, "scient.plugin.json")).then(
      () => true,
      () => false,
    ),
  );
  if (isPlugin) return [];
  const skillFolders = yield* Effect.promise(() => findSkillFolders(folder));
  if (skillFolders.length > 0) {
    return yield* Effect.forEach(skillFolders, (skillFolder, index) =>
      fromSkillFolder(String(index), skillFolder),
    );
  }
  const markers = ["manifest.json", ".mcp.json"];
  const isConnector = yield* Effect.promise(async () => {
    for (const marker of markers) {
      if (
        await NodeFSP.lstat(NodePath.join(folder, marker)).then(
          () => true,
          () => false,
        )
      )
        return true;
    }
    return false;
  });
  if (isConnector) return [];
  const notes = yield* Effect.promise(() => materialFiles(folder).catch(() => []));
  if (notes.length === 0) return [];
  if (notes.length === 1) {
    const file = NodePath.join(folder, notes[0]!);
    const contents = yield* readText(file);
    return [
      fromDocument({
        key: "0",
        contents,
        fallbackName: NodePath.basename(folder),
        materialPath: file,
      }),
    ];
  }
  const name = skillNameFrom(NodePath.basename(folder));
  return [
    {
      key: "0",
      ...(name ? { name } : {}),
      status: "needs-agent" as const,
      reason: `These ${notes.length} notes are not a skill yet.`,
      notes: [],
      material: { path: folder },
    },
  ];
});

const readText = (file: string) =>
  Effect.tryPromise({
    try: () => NodeFSP.stat(file),
    catch: () => sourceError("That file could not be read.", "unreadable"),
  }).pipe(
    Effect.flatMap((stat) =>
      stat.size > MAX_TEXT_BYTES
        ? Effect.fail(sourceError("That file is larger than 1 MiB.", "too-large"))
        : Effect.tryPromise({
            try: async () => decode(await NodeFSP.readFile(file)),
            catch: () => sourceError("That file could not be read.", "unreadable"),
          }),
    ),
  );

/** Unpack an archive's regular files; links and clutter are left out. */
const unpack = Effect.fn("PersonalSkillSources.unpack")(function* (
  archivePath: string,
  target: string,
) {
  yield* Effect.promise(() => NodeFSP.mkdir(target, { recursive: true }));
  yield* Effect.scoped(
    Effect.gen(function* () {
      const archive = yield* openZipArchive(archivePath, () =>
        sourceError("That archive could not be read.", "unreadable"),
      );
      if (archive.entryCount > MAX_ARCHIVE_ENTRIES) {
        return yield* sourceError("That archive has too many files.", "too-large");
      }
      let total = 0;
      for (;;) {
        const entry = yield* archive.next;
        if (entry === null) break;
        const name = entry.fileName;
        if (name.startsWith("__MACOSX/") || NodePath.posix.basename(name) === ".DS_Store") continue;
        if (((entry.externalFileAttributes >>> 16) & 0o170000) === 0o120000) continue;
        const destination = NodePath.join(target, name);
        if (!destination.startsWith(target + NodePath.sep)) {
          return yield* sourceError("That archive has a file outside its folder.", "unsafe");
        }
        if (name.endsWith("/")) {
          yield* Effect.promise(() => NodeFSP.mkdir(destination, { recursive: true }));
          continue;
        }
        total += entry.uncompressedSize;
        if (total > MAX_ARCHIVE_BYTES) {
          return yield* sourceError("That archive is larger than 50 MiB unpacked.", "too-large");
        }
        const readable = yield* archive.streamEntry(entry);
        yield* Effect.tryPromise({
          try: async () => {
            await NodeFSP.mkdir(NodePath.dirname(destination), { recursive: true });
            await NodeStreamPromises.pipeline(
              readable,
              NodeFS.createWriteStream(destination, { flags: "wx" }),
            );
          },
          catch: () => sourceError("That archive could not be unpacked.", "unreadable"),
        });
      }
    }),
  );
});

/** The one folder inside an archive that holds everything, as GitHub archives have. */
const archiveRoot = (folder: string) =>
  Effect.promise(async () => {
    const entries = (await NodeFSP.readdir(folder, { withFileTypes: true })).filter(
      (entry) => !entry.name.startsWith("."),
    );
    const only = entries[0];
    return entries.length === 1 && only?.isDirectory() ? NodePath.join(folder, only.name) : folder;
  });

const fromArchive = Effect.fn("PersonalSkillSources.fromArchive")(function* (
  archivePath: string,
  work: string,
) {
  const target = NodePath.join(work, "unpacked");
  yield* unpack(archivePath, target);
  return yield* fromFolder(yield* archiveRoot(target));
});

/** A file or folder on this computer. */
export const fromPath = Effect.fn("PersonalSkillSources.fromPath")(function* (
  path: string,
  work: string,
) {
  const stat = yield* Effect.tryPromise({
    try: () => NodeFSP.stat(path),
    catch: () => sourceError("Scient could not find that file or folder.", "not-found"),
  });
  const source: SkillSourceRecord = { kind: "file", label: NodePath.basename(path) };
  const done = (candidates: ReadonlyArray<StagedCandidate>): SkillSourceResult =>
    candidates.length === 0 ? NONE : { kind: "skills", source, candidates };
  if (stat.isDirectory()) return done(yield* fromFolder(path));
  const base = NodePath.basename(path);
  if (base === SKILL_DOCUMENT_FILE) {
    return done([yield* fromSkillFolder("0", NodePath.dirname(path))]);
  }
  if (ARCHIVE_FILE.test(base)) return done(yield* fromArchive(path, work));
  if (TEXT_FILE.test(base)) {
    const contents = yield* readText(path);
    return done([fromDocument({ key: "0", contents, fallbackName: base, materialPath: path })]);
  }
  return NONE;
});

/** Pasted text: a skill, or notes for an agent to turn into one. */
export const fromText = Effect.fn("PersonalSkillSources.fromText")(function* (
  text: string,
  name: string | undefined,
  work: string,
) {
  const materialPath = NodePath.join(work, "notes.md");
  yield* Effect.tryPromise({
    try: async () => {
      await NodeFSP.mkdir(work, { recursive: true });
      await NodeFSP.writeFile(materialPath, text);
    },
    catch: () => sourceError("Scient could not keep the pasted text.", "write-failed"),
  });
  return {
    kind: "skills",
    source: { kind: "text", label: "Pasted text" },
    candidates: [
      fromDocument({
        key: "0",
        contents: text,
        fallbackName: name ?? "pasted-skill",
        materialPath,
      }),
    ],
  } satisfies SkillSourceResult;
});

const GITHUB =
  /^https?:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/(tree|blob)\/([^/?#]+)(?:\/([^?#]*))?)?\/?(?:[?#].*)?$/u;

interface WebSkillSource {
  readonly download: string;
  readonly as: "archive" | "text";
  /** Inside the archive's top folder: the folder or file the address points at. */
  readonly inside?: string;
  readonly fileName: string;
}

/** Whether a web address is a skill source, and how to get it. Anything else is a connector. */
export const webSkillSource = (address: string): WebSkillSource | undefined => {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
  const github = GITHUB.exec(address);
  if (github) {
    const [, owner, repo, mode, ref, inside] = github;
    if (
      mode === "blob" &&
      inside &&
      TEXT_FILE.test(inside) &&
      !inside.endsWith(SKILL_DOCUMENT_FILE)
    ) {
      return {
        download: `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${inside}`,
        as: "text",
        fileName: NodePath.posix.basename(inside),
      };
    }
    return {
      download: `https://github.com/${owner}/${repo}/archive/${ref ?? "HEAD"}.zip`,
      as: "archive",
      ...(inside
        ? { inside: inside.endsWith(SKILL_DOCUMENT_FILE) ? NodePath.posix.dirname(inside) : inside }
        : {}),
      fileName: `${repo}.zip`,
    };
  }
  const fileName = NodePath.posix.basename(url.pathname);
  if (ARCHIVE_FILE.test(fileName)) return { download: url.href, as: "archive", fileName };
  if (TEXT_FILE.test(fileName)) return { download: url.href, as: "text", fileName };
  return undefined;
};

/** Code hosts whose files anyone can download, so an address on them names nothing private. */
const PUBLIC_HOSTS = new Set([
  "github.com",
  "raw.githubusercontent.com",
  "gist.github.com",
  "gist.githubusercontent.com",
  "gitlab.com",
  "huggingface.co",
  "codeberg.org",
  "bitbucket.org",
]);

/**
 * The host and path of an address on a public code host, without scheme or fragment, so analytics
 * can count which shared skills people add. Scient downloads without signing in, so a download
 * that worked was public. An address with a query is left out: it can carry a token (a private
 * repository's raw file link does), and then the download proves nothing about the path.
 */
export const publicSkillAddress = (address: string): string | undefined => {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return undefined;
  }
  if (url.username || url.password || url.search) return undefined;
  const host = url.hostname.toLowerCase().replace(/^www\./u, "");
  if (!PUBLIC_HOSTS.has(host)) return undefined;
  const value = `${host}${url.pathname.replace(/\/+$/u, "")}`;
  return value.length <= 200 ? value : undefined;
};

/** A web address: a GitHub repository or folder, a `SKILL.md` or text file, or an archive. */
export const fromUrl = Effect.fn("PersonalSkillSources.fromUrl")(function* (
  address: string,
  work: string,
) {
  const web = webSkillSource(address);
  if (web === undefined) return NONE;
  const http = yield* HttpClient.HttpClient;
  const limit = web.as === "archive" ? MAX_ARCHIVE_BYTES : MAX_TEXT_BYTES;
  const tooLarge = sourceError(
    web.as === "archive"
      ? "That download is larger than 50 MiB."
      : "That file is larger than 1 MiB.",
    "too-large",
  );
  const bytes = yield* Effect.gen(function* () {
    const response = yield* http.execute(HttpClientRequest.get(web.download));
    if (response.status !== 200) {
      return yield* sourceError(
        response.status === 404
          ? "Nothing was found at that address. If it is private, download it and add the file."
          : `That address answered with HTTP ${response.status}.`,
        response.status === 404 ? "not-found" : "download-failed",
      );
    }
    if (Number(response.headers["content-length"] ?? "0") > limit) return yield* tooLarge;
    const read = yield* response.stream.pipe(
      Stream.runFoldEffect(
        () => ({ size: 0, parts: [] as Uint8Array[] }),
        (accumulated, chunk: Uint8Array) => {
          const size = accumulated.size + chunk.byteLength;
          if (size > limit) return Effect.fail(tooLarge);
          accumulated.parts.push(chunk);
          return Effect.succeed({ size, parts: accumulated.parts });
        },
      ),
    );
    return Buffer.concat(read.parts, read.size);
  }).pipe(
    Effect.mapError((error) =>
      error._tag === "ScientSkillManagementError"
        ? error
        : sourceError("Scient could not download that address.", "download-failed"),
    ),
  );
  const publicAddress = publicSkillAddress(address);
  const source: SkillSourceRecord = {
    kind: "url",
    label: address,
    ...(publicAddress ? { publicAddress } : {}),
  };
  const file = NodePath.join(work, web.fileName);
  yield* Effect.tryPromise({
    try: async () => {
      await NodeFSP.mkdir(work, { recursive: true });
      await NodeFSP.writeFile(file, bytes);
    },
    catch: () => sourceError("Scient could not keep the download.", "write-failed"),
  });
  let candidates: ReadonlyArray<StagedCandidate>;
  if (web.as === "text") {
    const contents = decode(bytes);
    const fallback =
      web.fileName === SKILL_DOCUMENT_FILE
        ? NodePath.posix.basename(NodePath.posix.dirname(new URL(web.download).pathname))
        : web.fileName;
    candidates = [fromDocument({ key: "0", contents, fallbackName: fallback, materialPath: file })];
  } else {
    const target = NodePath.join(work, "unpacked");
    yield* unpack(file, target);
    const root = yield* archiveRoot(target);
    const inside = web.inside ? NodePath.join(root, ...web.inside.split("/")) : root;
    if (!inside.startsWith(root))
      return yield* sourceError("That address is not inside its repository.", "unsafe");
    const isFile = yield* Effect.promise(() =>
      NodeFSP.stat(inside).then(
        (stat) => stat.isFile(),
        () => false,
      ),
    );
    candidates = isFile
      ? [
          fromDocument({
            key: "0",
            contents: yield* readText(inside),
            fallbackName: NodePath.basename(inside),
            materialPath: inside,
          }),
        ]
      : yield* fromFolder(inside);
  }
  if (candidates.length === 0) {
    return yield* sourceError("Scient found no skill or notes at that address.", "nothing-found");
  }
  return { kind: "skills", source, candidates } satisfies SkillSourceResult;
});
