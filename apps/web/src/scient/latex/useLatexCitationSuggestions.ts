import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useRef } from "react";

import { useStableCallback } from "~/hooks/useStableCallback";
import { m } from "~/i18n/messages";
import { projectEnvironment } from "~/state/projects";
import { useAtomQueryRunner } from "~/state/use-atom-query-runner";

import {
  filterLibraryCitations,
  LIBRARY_BIBLIOGRAPHY_HINT,
  type LibraryCitationCandidate,
} from "../sources/libraryCitations";
import { useLibraryVersionStore } from "../sources/librarySourceRequest";
import { useLibraryCitations } from "../sources/useLibraryCitations";
import { bibliographyChoices } from "./latexAuthoringModel";
import type { LatexCitationSuggestion } from "./latexCommandCompletion";
import { refreshLatexCompletions } from "./latexTextCompletion";
import { processVisualDocumentAsync } from "./visualProcessing";

/** As the References panel: the first bibliography files a document links. */
const FILE_LIMIT = 24;
/** A bibliography file is read again once its last read is this old and a citation is typed. */
const READ_AGAIN_AFTER_MS = 5_000;
const IN_WORKER_FROM = 12_000;

interface FileEntries {
  readonly readAt: number;
  readonly pending: boolean;
  readonly entries: ReadonlyArray<LibraryCitationCandidate>;
}

async function entriesOf(contents: string, path: string) {
  const choices =
    contents.length < IN_WORKER_FROM || typeof Worker === "undefined"
      ? bibliographyChoices(contents, path)
      : await processVisualDocumentAsync(
          { kind: "bibliography", source: contents, path },
          new AbortController().signal,
        ).then((result) => (result?.kind === "bibliography" ? result.choices : []));
  return choices.map((choice) => ({
    // Not a Library source: the document's own file defines it.
    sourceId: "",
    citationKey: choice.key,
    label: choice.detail,
    title: choice.title === choice.key ? null : choice.title,
  }));
}

/**
 * What a typed LaTeX citation offers: the entries of the document's linked `.bib` files, then
 * the project's Library sources. The function keeps its identity and reads the newest of both,
 * so an editor can hold it for as long as it lives.
 */
export function useLatexCitationSuggestions(input: {
  /** Null offers nothing, for a document outside a project or one that is not LaTeX. */
  readonly environmentId: EnvironmentId | null;
  readonly root: string | null;
  /** The `.bib` files the document links now, and whether it is a whole document. */
  readonly bibliography: () => {
    readonly paths: ReadonlyArray<string>;
    readonly wholeDocument: boolean;
  };
}): (typed: string) => ReadonlyArray<LatexCitationSuggestion> {
  const root = input.root ?? "";
  const environmentId = root ? input.environmentId : null;
  const version = useLibraryVersionStore((state) => state.byRoot[root] ?? "");
  const library = useLibraryCitations({ environmentId, root, refresh: version });
  const readFile = useAtomQueryRunner(projectEnvironment.readFile, {
    reportFailure: false,
    refresh: true,
  });
  const context = `${environmentId}\0${root}`;
  const files = useRef<{ context: string; byPath: Map<string, FileEntries> }>({
    context,
    byPath: new Map(),
  });
  // The editors ask on key down, input and key up: the last answer serves the repeats.
  const answered = useRef<{
    readonly key: string;
    readonly library: typeof library;
    readonly result: ReadonlyArray<LatexCitationSuggestion>;
  } | null>(null);

  const read = useStableCallback((paths: ReadonlyArray<string>) => {
    if (environmentId === null) return;
    if (files.current.context !== context) files.current = { context, byPath: new Map() };
    const { byPath } = files.current;
    const now = Date.now();
    for (const path of paths) {
      const known = byPath.get(path);
      if (known && (known.pending || now - known.readAt < READ_AGAIN_AFTER_MS)) continue;
      byPath.set(path, { readAt: now, pending: true, entries: known?.entries ?? [] });
      void readFile({ environmentId, input: { cwd: root, relativePath: path } })
        .then((result) =>
          result._tag === "Success" && !result.value.truncated
            ? entriesOf(result.value.contents, path)
            : [],
        )
        .catch(() => [])
        .then((entries) => {
          // A file that is gone or unreadable offers nothing, like one that is empty.
          byPath.set(path, { readAt: Date.now(), pending: false, entries });
          answered.current = null;
          // An open list shows the file's entries without waiting for the next key.
          refreshLatexCompletions();
        });
    }
  });
  const linked = useStableCallback(() => {
    const { paths, wholeDocument } = input.bibliography();
    return {
      paths: paths.slice(0, FILE_LIMIT),
      // The managed references.bib at the project root is how a document reaches the Library.
      reachesLibrary: !wholeDocument || paths.includes("references.bib"),
    };
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the document's bibliography files from the environment when the editor opens, so the first typed citation already has them
  useEffect(() => {
    // Another project's files are not this one's.
    if (files.current.context !== context) files.current = { context, byPath: new Map() };
    read(linked().paths);
  }, [context, read, linked]);

  return useStableCallback((typed: string) => {
    if (environmentId === null) return [];
    const { paths, reachesLibrary } = linked();
    read(paths);
    const key = JSON.stringify([typed, paths, reachesLibrary]);
    if (answered.current?.key === key && answered.current.library === library) {
      return answered.current.result;
    }
    const byPath = files.current.context === context ? files.current.byPath : null;
    const own = new Map<string, LibraryCitationCandidate>();
    for (const path of paths) {
      for (const entry of byPath?.get(path)?.entries ?? []) {
        if (!own.has(entry.citationKey)) own.set(entry.citationKey, entry);
      }
    }
    const result = filterLibraryCitations(
      [...own.values(), ...(library ?? []).filter((source) => !own.has(source.citationKey))],
      typed,
    ).map((candidate) => ({
      key: candidate.citationKey,
      detail: [candidate.label === candidate.citationKey ? null : candidate.label, candidate.title]
        .filter((part) => part !== null)
        .join(" · "),
      ...(candidate.sourceId && !reachesLibrary ? { note: m(LIBRARY_BIBLIOGRAPHY_HINT) } : {}),
    }));
    answered.current = { key, library, result };
    return result;
  });
}
