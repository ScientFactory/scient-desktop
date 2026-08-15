// @effect-diagnostics nodeBuiltinImport:off -- Input identity is a host SHA-256 digest.
/**
 * What a published PDF was built from, and whether that is still true.
 *
 * A build request carries only a workspace root and a path, so nothing in the
 * request says which revision of the sources it means. Without that, a PDF
 * published once keeps its `current` binding for as long as the binding
 * survives — across restarts, across an agent rewriting the root document,
 * across an editor outside Scient changing an `\input`ed chapter — and the
 * viewer keeps calling it built. This module is the missing half: after a
 * successful publish the service records the identity of every file the compile
 * actually read, and before reporting that PDF as current again it checks that
 * identity still holds.
 *
 * Identity is content, not timestamps. A dependency is a workspace-relative
 * path, the SHA-256 of its bytes, and its byte length; a file the run read that
 * is no longer there keeps its place in the list under `MISSING_FILE_DIGEST`,
 * because "the chapter was deleted" is a change, not an absence of one. Two
 * shapes get a marker instead of a digest: a missing file, and one too large to
 * hash on a status poll (`OVERSIZE_FILE_DIGEST`), whose identity falls back to
 * its size — a fifty-megabyte figure is not worth rehashing every 1.5 seconds
 * and does not change without changing size in practice.
 *
 * The probe is built to be run on every poll, which is the constraint that
 * shapes it: one `stat` per dependency, and a content hash only where the size
 * or the modification time says something might have moved. `LatexEvidenceMark`
 * is that memory — the size and mtime last *verified* to match the recorded
 * digest — so an editor that rewrites a file with identical bytes (a formatter,
 * a checkout, a save with no edit) costs one hash and then stops costing
 * anything, instead of rebuilding the document on every touch.
 */
import * as NodeCrypto from "node:crypto";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

/** Recorded for a dependency the compile read that is no longer on disk. */
export const MISSING_FILE_DIGEST = "missing";
/** Recorded for a dependency too large to rehash on a status poll. */
export const OVERSIZE_FILE_DIGEST = "oversize";
/** Beyond this a dependency is identified by its size alone. */
export const MAX_HASHED_DEPENDENCY_BYTES = 16 * 1_024 * 1_024;
/** The same ceiling the recorder manifest applies, enforced again here. */
export const MAX_EVIDENCE_DEPENDENCIES = 256;

const LatexDependencyEvidence = Schema.Struct({
  /** Workspace-relative, forward slashes. */
  path: Schema.String,
  sha256: Schema.String,
  /** `-1` for a dependency that was not there when the evidence was taken. */
  byteLength: Schema.Int,
});
type LatexDependencyEvidence = typeof LatexDependencyEvidence.Type;

export const LatexBuildEvidence = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  rootRelativePath: Schema.String,
  recordedAtEpochMs: Schema.Number,
  /**
   * The compile named more inputs than this lane will track, so `dependencies`
   * covers the root document only. Recorded rather than hidden: a reader of
   * this file must not mistake a deliberately narrowed list for a complete one.
   */
  truncated: Schema.Boolean,
  dependencies: Schema.Array(LatexDependencyEvidence),
});
export type LatexBuildEvidence = typeof LatexBuildEvidence.Type;

const EvidenceJson = Schema.fromJsonString(LatexBuildEvidence);
const encodeEvidence = Schema.encodeSync(EvidenceJson);
const decodeEvidence = Schema.decodeUnknownSync(EvidenceJson);

export function encodeLatexBuildEvidence(evidence: LatexBuildEvidence): string {
  return encodeEvidence(evidence);
}

/**
 * `null` for anything this version cannot read — a state file written before
 * evidence existed, a schema version it does not know, a truncated write. The
 * caller treats that exactly as it treats a mismatch: rebuild once, and the
 * build that follows writes a file this version does understand.
 */
export function decodeLatexBuildEvidence(source: string): LatexBuildEvidence | null {
  try {
    return decodeEvidence(source);
  } catch {
    return null;
  }
}

/** Size and mtime last seen to still match a dependency's recorded digest. */
export interface LatexEvidenceMark {
  readonly size: number;
  readonly mtimeMs: number | null;
}

export type LatexEvidenceMarks = ReadonlyMap<string, LatexEvidenceMark>;

export const EMPTY_EVIDENCE_MARKS: LatexEvidenceMarks = new Map<string, LatexEvidenceMark>();

interface StatSnapshot {
  readonly size: number;
  readonly mtimeMs: number | null;
}

const statOf = (absolutePath: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* fileSystem.stat(absolutePath).pipe(
      Effect.map((info) =>
        info.type === "File"
          ? Option.some<StatSnapshot>({
              size: Number(info.size),
              mtimeMs: Option.match(info.mtime, {
                onNone: () => null,
                onSome: (mtime) => mtime.getTime(),
              }),
            })
          : Option.none<StatSnapshot>(),
      ),
      Effect.orElseSucceed(() => Option.none<StatSnapshot>()),
    );
  });

const digestOf = (absolutePath: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* fileSystem.readFile(absolutePath).pipe(
      Effect.map((bytes) =>
        Option.some(NodeCrypto.createHash("sha256").update(bytes).digest("hex")),
      ),
      Effect.orElseSucceed(() => Option.none<string>()),
    );
  });

/**
 * The dependency list this lane will stand behind. The root document is always
 * in it — it is the one file whose change nothing else could reveal — and a
 * list that overflows the cap collapses to the root alone rather than to its
 * first 256 entries, so `truncated` always means "narrower than the truth" and
 * never "silently partial".
 */
function boundedDependencies(input: {
  readonly rootRelativePath: string;
  readonly dependencies: ReadonlyArray<string>;
  readonly truncated: boolean;
}): { readonly paths: ReadonlyArray<string>; readonly truncated: boolean } {
  const unique = [...new Set([input.rootRelativePath, ...input.dependencies])].sort();
  const truncated = input.truncated || unique.length > MAX_EVIDENCE_DEPENDENCIES;
  return { paths: truncated ? [input.rootRelativePath] : unique, truncated };
}

/**
 * Reads the identity of every dependency, once, after a successful publish.
 *
 * The race this accepts and does not close: the compile read these files
 * moments ago, and a save landing between the engine's exit and this read is
 * recorded as what the PDF was built from when it was not. The cost of that is
 * one missed rebuild of one document, which the next save corrects; the cost of
 * closing it — hashing every input before and after the compile and rejecting a
 * mismatch — is paid by every build of every document forever.
 */
export const collectLatexBuildEvidence = (input: {
  readonly workspaceRoot: string;
  readonly rootRelativePath: string;
  readonly dependencies: ReadonlyArray<string>;
  readonly truncated: boolean;
  readonly nowEpochMs: number;
}): Effect.Effect<
  { readonly evidence: LatexBuildEvidence; readonly marks: LatexEvidenceMarks },
  never,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const { paths, truncated } = boundedDependencies(input);
    const dependencies: LatexDependencyEvidence[] = [];
    const marks = new Map<string, LatexEvidenceMark>();

    for (const relativePath of paths) {
      const absolutePath = path.resolve(input.workspaceRoot, relativePath);
      const info = yield* statOf(absolutePath);
      if (Option.isNone(info)) {
        dependencies.push({ path: relativePath, sha256: MISSING_FILE_DIGEST, byteLength: -1 });
        continue;
      }
      if (info.value.size > MAX_HASHED_DEPENDENCY_BYTES) {
        dependencies.push({
          path: relativePath,
          sha256: OVERSIZE_FILE_DIGEST,
          byteLength: info.value.size,
        });
        marks.set(relativePath, info.value);
        continue;
      }
      const digest = yield* digestOf(absolutePath);
      if (Option.isNone(digest)) {
        dependencies.push({ path: relativePath, sha256: MISSING_FILE_DIGEST, byteLength: -1 });
        continue;
      }
      dependencies.push({
        path: relativePath,
        sha256: digest.value,
        byteLength: info.value.size,
      });
      marks.set(relativePath, info.value);
    }

    return {
      evidence: {
        schemaVersion: 1 as const,
        rootRelativePath: input.rootRelativePath,
        recordedAtEpochMs: input.nowEpochMs,
        truncated,
        dependencies,
      },
      marks,
    };
  });

export interface LatexEvidenceProbe {
  /** At least one dependency no longer matches what the PDF was built from. */
  readonly changed: boolean;
  /** The first dependency that disagreed, for the log; `null` when none did. */
  readonly changedPath: string | null;
  /** Carry this back into the next probe; it is what keeps a poll cheap. */
  readonly marks: LatexEvidenceMarks;
}

/**
 * Whether the recorded evidence still describes what is on disk.
 *
 * Cheap by construction and by ordering: one `stat` per dependency, a size
 * difference decides on its own, and the content hash is read only when size
 * and mtime together leave the question open. The first disagreement ends the
 * probe — the answer is already known and every further read is waste.
 */
export const probeLatexEvidence = (input: {
  readonly workspaceRoot: string;
  readonly evidence: LatexBuildEvidence;
  readonly marks: LatexEvidenceMarks;
}): Effect.Effect<LatexEvidenceProbe, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const marks = new Map(input.marks);
    const verdict = (changedPath: string | null): LatexEvidenceProbe => ({
      changed: changedPath !== null,
      changedPath,
      marks,
    });

    for (const dependency of input.evidence.dependencies) {
      const absolutePath = path.resolve(input.workspaceRoot, dependency.path);
      const info = yield* statOf(absolutePath);
      if (Option.isNone(info)) {
        marks.delete(dependency.path);
        // A file that was already gone when the evidence was taken is not news.
        if (dependency.sha256 === MISSING_FILE_DIGEST) continue;
        return verdict(dependency.path);
      }
      if (dependency.sha256 === MISSING_FILE_DIGEST) return verdict(dependency.path);
      if (info.value.size !== dependency.byteLength) {
        marks.delete(dependency.path);
        return verdict(dependency.path);
      }
      // Same size as recorded. A file whose size and mtime are both where they
      // were left has not been rewritten, and this is the branch every poll of
      // an untouched document takes.
      const mark = input.marks.get(dependency.path);
      if (
        mark !== undefined &&
        mark.size === info.value.size &&
        mark.mtimeMs === info.value.mtimeMs
      )
        continue;
      // Size held but the timestamp moved, or nothing is remembered about this
      // file yet (the first probe after a restart). Only the bytes can answer,
      // and an mtime that moved without them is not a reason to rebuild.
      if (dependency.sha256 === OVERSIZE_FILE_DIGEST) {
        marks.set(dependency.path, info.value);
        continue;
      }
      const digest = yield* digestOf(absolutePath);
      if (Option.isNone(digest) || digest.value !== dependency.sha256) {
        marks.delete(dependency.path);
        return verdict(dependency.path);
      }
      marks.set(dependency.path, info.value);
    }

    return verdict(null);
  });
