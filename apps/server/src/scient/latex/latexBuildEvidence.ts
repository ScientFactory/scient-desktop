// @effect-diagnostics nodeBuiltinImport:off -- Input identity is a host SHA-256 digest.
/**
 * Current PDF evidence binds dependency content hashes/lengths, not timestamps; distinguish missing
 * from unreadable and stream large hashes. Stat shortcuts use only last verified marks to avoid
 * rebuilds on identical rewrites. Legacy size-only markers remain migration inputs, not fresh
 * identity.
 */
import * as NodeCrypto from "node:crypto";

import { ArtifactId, ArtifactRevisionId } from "@scientfactory/document-artifacts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

/** Recorded for a dependency the compile read that is no longer on disk. */
export const MISSING_FILE_DIGEST = "missing";
/** Legacy marker read from evidence written before large inputs were hashed. */
const OVERSIZE_FILE_DIGEST = "oversize";
/**
 * Unreadable is not missing: Windows locks/scanners can return EBUSY/EACCES for present files. Keep
 * unknown evidence unchanged until readable, then request one rebuild; alternating false
 * absence/presence would create an unbounded compile loop.
 */
export const UNVERIFIED_FILE_DIGEST = "unverified";
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

/**
 * Durable evidence is meaningful only for the immutable PDF revision whose
 * compile produced it. Keeping that identity in the file prevents a crash
 * between two publications from lending the previous PDF's source evidence to
 * the newly bound revision.
 */
export const PublishedLatexBuildEvidence = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  artifactId: ArtifactId,
  revisionId: ArtifactRevisionId,
  evidence: LatexBuildEvidence,
  /** Legacy hash-only evidence cannot establish freshness across first-party source ABA. */
  mutationEpoch: Schema.optional(Schema.NonEmptyString),
  compiledBibliography: Schema.optional(Schema.String.check(Schema.isMaxLength(1_000_000))),
  /** Pre/post-compile-qualified source identities; absence cannot authorize source navigation. */
  sourceRevisions: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});
export type PublishedLatexBuildEvidence = typeof PublishedLatexBuildEvidence.Type;

/** Current-source export requires stable inputs across the compile, not merely a post-build stat. */
export function latexVisualSourceRevisions(
  before: LatexBuildEvidence,
  after: LatexBuildEvidence,
): Readonly<Record<string, string>> {
  if (before.truncated || after.truncated) return {};
  const prior = new Map(before.dependencies.map((item) => [item.path, item.sha256]));
  if (
    after.dependencies.some(
      (item) => prior.get(item.path) !== item.sha256 || !/^[a-f0-9]{64}$/u.test(item.sha256),
    )
  )
    return {};
  return Object.fromEntries(
    after.dependencies
      .filter((item) => /\.(?:tex|latex|ltx)$/iu.test(item.path))
      .map((item) => [item.path, `sha256:${item.sha256}`]),
  );
}

/**
 * A complete recorder may discover workspace inputs that were not available to
 * the pre-compile snapshot. One bounded second compile can then observe that
 * now-known set on both sides; transient changes and incomplete evidence never
 * qualify for an automatic retry here.
 */
export function latexVisualNeedsRequalification(
  before: LatexBuildEvidence,
  after: LatexBuildEvidence,
): boolean {
  if (after.truncated) return false;
  if (!after.dependencies.every((item) => /^[a-f0-9]{64}$/u.test(item.sha256))) return false;
  if (before.truncated) return true;
  const prior = new Map(before.dependencies.map((item) => [item.path, item.sha256]));
  return (
    before.dependencies.length !== after.dependencies.length ||
    after.dependencies.some((item) => prior.get(item.path) !== item.sha256)
  );
}

/** A definite source-set or content change observed across one engine run. */
export function latexBuildInputsChangedDuringCompile(
  before: LatexBuildEvidence,
  after: LatexBuildEvidence,
): boolean {
  if (before.truncated || after.truncated) return false;
  if (
    !before.dependencies.every((item) => /^[a-f0-9]{64}$/u.test(item.sha256)) ||
    !after.dependencies.every((item) => /^[a-f0-9]{64}$/u.test(item.sha256))
  )
    return false;
  const prior = new Map(before.dependencies.map((item) => [item.path, item.sha256]));
  return (
    before.dependencies.length !== after.dependencies.length ||
    after.dependencies.some((item) => prior.get(item.path) !== item.sha256)
  );
}

const EvidenceJson = Schema.fromJsonString(LatexBuildEvidence);
const encodeEvidence = Schema.encodeSync(EvidenceJson);
const decodeEvidence = Schema.decodeUnknownSync(EvidenceJson);
const PublishedEvidenceJson = Schema.fromJsonString(PublishedLatexBuildEvidence);
const encodePublishedEvidence = Schema.encodeSync(PublishedEvidenceJson);
const decodePublishedEvidence = Schema.decodeUnknownSync(PublishedEvidenceJson);

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

export function encodePublishedLatexBuildEvidence(evidence: PublishedLatexBuildEvidence): string {
  return encodePublishedEvidence(evidence);
}

/** Legacy unscoped evidence deliberately decodes to `null` and earns one rebuild. */
export function decodePublishedLatexBuildEvidence(
  source: string,
): PublishedLatexBuildEvidence | null {
  try {
    return decodePublishedEvidence(source);
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

/**
 * Absence is durable evidence; unreadability describes only this attempt. Never collapse them, or a
 * transient scanner/file lock can create repeated rebuilds.
 */
type ReadOutcome<A> =
  | { readonly _tag: "ok"; readonly value: A }
  | { readonly _tag: "absent" }
  | { readonly _tag: "unreadable" };

const OK = <A>(value: A): ReadOutcome<A> => ({ _tag: "ok", value });
const ABSENT: ReadOutcome<never> = { _tag: "absent" };
const UNREADABLE: ReadOutcome<never> = { _tag: "unreadable" };

/**
 * Only a genuine `NotFound` earns `absent`. Every other platform error — a
 * lock, a permission, a device that went away — is `unreadable`, because the
 * one thing this call has established is that it does not know.
 */
const classifyError = (error: {
  readonly reason: { readonly _tag: string };
}): ReadOutcome<never> => (error.reason._tag === "NotFound" ? ABSENT : UNREADABLE);

const statOf = Effect.fn("latexBuildEvidence.statOf")(function* (absolutePath: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.stat(absolutePath).pipe(
    Effect.map((info) =>
      info.type === "File"
        ? OK<StatSnapshot>({
            size: Number(info.size),
            mtimeMs: Option.match(info.mtime, {
              onNone: () => null,
              onSome: (mtime) => mtime.getTime(),
            }),
          })
        : // A directory where a `.tex` file used to be is not a transient
          // condition; the file the compile read is gone either way.
          ABSENT,
    ),
    Effect.catchTags({ PlatformError: (error) => Effect.succeed(classifyError(error)) }),
    Effect.orElseSucceed(() => UNREADABLE),
  );
});

const digestOf = Effect.fn("latexBuildEvidence.digestOf")(function* (absolutePath: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.stream(absolutePath).pipe(
    Stream.runFold(
      () => NodeCrypto.createHash("sha256"),
      (hash, chunk) => hash.update(chunk),
    ),
    Effect.map((hash) => OK(hash.digest("hex"))),
    Effect.catchTags({ PlatformError: (error) => Effect.succeed(classifyError(error)) }),
    Effect.orElseSucceed(() => UNREADABLE),
  );
});

/**
 * Always include the root dependency. On overflow, keep root alone and mark truncated rather than
 * silently retaining an arbitrary partial prefix.
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
 * Accepted race: a save after engine exit but before evidence read can be recorded as build input
 * despite missing the PDF. The next save corrects that missed rebuild; closing it would require
 * pre/post hashes on every compile.
 */
export const collectLatexBuildEvidence = Effect.fn("latexBuildEvidence.collectLatexBuildEvidence")(
  function* (input: {
    readonly workspaceRoot: string;
    readonly rootRelativePath: string;
    readonly dependencies: ReadonlyArray<string>;
    readonly truncated: boolean;
    readonly nowEpochMs: number;
  }): Effect.fn.Return<
    { readonly evidence: LatexBuildEvidence; readonly marks: LatexEvidenceMarks },
    never,
    FileSystem.FileSystem | Path.Path
  > {
    const path = yield* Path.Path;
    const { paths, truncated } = boundedDependencies(input);
    const dependencies: LatexDependencyEvidence[] = [];
    const marks = new Map<string, LatexEvidenceMark>();

    for (const relativePath of paths) {
      const absolutePath = path.resolve(input.workspaceRoot, relativePath);
      const info = yield* statOf(absolutePath);
      if (info._tag !== "ok") {
        // Both markers carry `-1`: no bytes were hashed either way, and a
        // length recorded beside a marker digest only invites a later reader to
        // compare the two.
        dependencies.push({
          path: relativePath,
          sha256: info._tag === "absent" ? MISSING_FILE_DIGEST : UNVERIFIED_FILE_DIGEST,
          byteLength: -1,
        });
        continue;
      }
      const digest = yield* digestOf(absolutePath);
      if (digest._tag !== "ok") {
        // It was there a moment ago at `stat` time, so an `absent` here means
        // it was deleted between the two calls — still a real absence.
        dependencies.push({
          path: relativePath,
          sha256: digest._tag === "absent" ? MISSING_FILE_DIGEST : UNVERIFIED_FILE_DIGEST,
          byteLength: -1,
        });
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
  },
);

/**
 * Compare dependency paths/digests/lengths, not recording time. Recollect before rebuilding after a
 * stat-probe disagreement; equal content means no compile, bounding shortcut disagreements instead
 * of rebuilding every poll.
 */
export function latexEvidenceMatches(a: LatexBuildEvidence, b: LatexBuildEvidence): boolean {
  if (a.rootRelativePath !== b.rootRelativePath) return false;
  if (a.truncated !== b.truncated) return false;
  if (a.dependencies.length !== b.dependencies.length) return false;
  return a.dependencies.every((dependency, index) => {
    const other = b.dependencies[index];
    return (
      other !== undefined &&
      dependency.path === other.path &&
      dependency.sha256 === other.sha256 &&
      dependency.byteLength === other.byteLength
    );
  });
}

export interface LatexEvidenceProbe {
  /** At least one dependency no longer matches what the PDF was built from. */
  readonly changed: boolean;
  /** The first dependency that disagreed, for the log; `null` when none did. */
  readonly changedPath: string | null;
  /** Carry this back into the next probe; it is what keeps a poll cheap. */
  readonly marks: LatexEvidenceMarks;
}

/**
 * Use one stat per dependency and hash only when metadata cannot settle identity. Stop at the first
 * disagreement because further reads cannot change the verdict.
 */
export const probeLatexEvidence = Effect.fn("latexBuildEvidence.probeLatexEvidence")(
  function* (input: {
    readonly workspaceRoot: string;
    readonly evidence: LatexBuildEvidence;
    readonly marks: LatexEvidenceMarks;
    /**
     * Unverified dependencies that already earned their one rebuild in this
     * process. If evidence collection after that build hit the same transient
     * lock, a later readable poll must not start a 15-second rebuild loop.
     */
    readonly reverifiedUnverifiedPaths?: ReadonlySet<string>;
  }): Effect.fn.Return<LatexEvidenceProbe, never, FileSystem.FileSystem | Path.Path> {
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
      if (dependency.sha256 === UNVERIFIED_FILE_DIGEST) {
        // Do not turn a transient lock into a rebuild loop. Once the file is
        // observable again, however, rebuild exactly once so the next evidence
        // record contains the identity the successful compile actually used.
        if (info._tag === "unreadable") continue;
        if (input.reverifiedUnverifiedPaths?.has(dependency.path) === true) continue;
        marks.delete(dependency.path);
        return verdict(dependency.path);
      }
      if (info._tag === "unreadable") {
        // Present and unavailable. The recorded digest stands, the mark stands
        // with it — an unreadable poll is not a reason to rebuild, and not a
        // reason to forget what the last readable one verified either.
        continue;
      }
      if (info._tag === "absent") {
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
      // An mtime change alone does not justify rebuild; verify bytes. Legacy size-only evidence
      // needs replacement with a digest after restart or timestamp movement, while an unchanged
      // live verified mark can avoid that one migration rebuild.
      if (dependency.sha256 === OVERSIZE_FILE_DIGEST) return verdict(dependency.path);
      const digest = yield* digestOf(absolutePath);
      // Same rule as the `stat` above: only an answer decides. A read that
      // could not happen leaves the recorded digest exactly where it was.
      if (digest._tag === "unreadable") continue;
      if (digest._tag === "absent" || digest.value !== dependency.sha256) {
        marks.delete(dependency.path);
        return verdict(dependency.path);
      }
      marks.set(dependency.path, info.value);
    }

    return verdict(null);
  },
);
