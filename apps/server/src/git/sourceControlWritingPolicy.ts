import { Effect } from "effect";
import type { SourceControlWritingSettings } from "@synara/contracts";

import type { GitCoreShape } from "./Services/GitCore.ts";
import type { SourceControlWritingPolicy } from "./Services/TextGeneration.ts";

const RECENT_COMMIT_LIMIT = 20;
const RECENT_COMMIT_SUBJECT_MAX_CHARS = 160;
const RECENT_COMMIT_OUTPUT_MAX_BYTES = 4_096;
const LOCAL_HISTORY_ENV = {
  GIT_NO_LAZY_FETCH: "1",
  GIT_NO_REPLACE_OBJECTS: "1",
} as const;

function sanitizeCommitSubjectEvidence(value: string): string {
  const firstLine = value.trim().split(/\r?\n/u)[0] ?? "";
  const printable = Array.from(firstLine)
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint >= 32 && codePoint !== 127;
    })
    .join("")
    .trim();
  return printable.slice(0, RECENT_COMMIT_SUBJECT_MAX_CHARS).trimEnd();
}

const readRecentCommitSubjects = (input: {
  readonly cwd: string;
  readonly execute: GitCoreShape["execute"];
}) =>
  Effect.gen(function* () {
    const head = yield* input.execute({
      operation: "SourceControlWritingPolicy.verifyHead",
      cwd: input.cwd,
      args: ["rev-parse", "--verify", "HEAD"],
      env: LOCAL_HISTORY_ENV,
      allowNonZeroExit: true,
      timeoutMs: 5_000,
      maxOutputBytes: 256,
    });
    if (head.code !== 0) return [];

    const result = yield* input.execute({
      operation: "SourceControlWritingPolicy.readRecentCommitSubjects",
      cwd: input.cwd,
      args: ["log", "-n", String(RECENT_COMMIT_LIMIT), "--no-merges", "--format=%s"],
      env: LOCAL_HISTORY_ENV,
      timeoutMs: 5_000,
      maxOutputBytes: RECENT_COMMIT_OUTPUT_MAX_BYTES,
    });
    const uniqueSubjects = new Set<string>();
    for (const rawSubject of result.stdout.split(/\r?\n/u)) {
      const subject = sanitizeCommitSubjectEvidence(rawSubject);
      if (subject.length > 0) uniqueSubjects.add(subject);
      if (uniqueSubjects.size >= RECENT_COMMIT_LIMIT) break;
    }
    return [...uniqueSubjects];
  });

export const resolveSourceControlWritingPolicy = Effect.fn("resolveSourceControlWritingPolicy")(
  function* (input: {
    readonly cwd: string;
    readonly settings: SourceControlWritingSettings;
    readonly execute: GitCoreShape["execute"];
  }) {
    switch (input.settings.mode) {
      case "standard":
        return undefined;
      case "conventional_commits":
        return {
          mode: "conventional_commits",
        } satisfies SourceControlWritingPolicy;
      case "custom": {
        const customInstructions = input.settings.customInstructions.trim();
        return customInstructions.length === 0
          ? undefined
          : ({
              mode: "custom",
              customInstructions,
            } satisfies SourceControlWritingPolicy);
      }
      case "repository_conventions": {
        const recentCommitSubjects = yield* readRecentCommitSubjects(input).pipe(
          Effect.catch(() =>
            Effect.logWarning(
              "source-control writing could not read local commit subjects; using standard behavior",
            ).pipe(Effect.as(null)),
          ),
        );
        if (recentCommitSubjects === null) return undefined;
        return recentCommitSubjects.length === 0
          ? undefined
          : ({
              mode: "repository_conventions",
              recentCommitSubjects,
            } satisfies SourceControlWritingPolicy);
      }
    }
  },
);
