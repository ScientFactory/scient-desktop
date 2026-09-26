import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useProjectEntriesQuery } from "~/components/files/projectFilesQueryState";
import { projectEnvironment } from "~/state/projects";
import { useAtomQueryRunner } from "~/state/use-atom-query-runner";
import {
  bibliographyChoices,
  bibliographyPaths,
  inlineBibliographyChoices,
  type LatexReferenceChoice,
} from "./latexAuthoringModel";
import {
  indexLatexSource,
  latexSourcePathBase,
  linkedLatexFiles,
  type SourceCommand,
} from "./latexSourceModel";

export interface SourceProjectIndex {
  labels: { key: string; file: string; line: number }[];
  citations: LatexReferenceChoice[];
  commands: SourceCommand[];
  environments: string[];
  files: string[];
  pending: boolean;
  unavailable: string[];
  limited: boolean;
}
const emptyIndex = {
  labels: [],
  citations: [],
  commands: [],
  environments: [],
  unavailable: [],
  limited: false,
};

export function useLatexSourceProject(props: {
  environmentId: EnvironmentId;
  cwd: string;
  relativePath: string;
  rootPath: string;
  source: string;
}) {
  const entries = useProjectEntriesQuery(props.environmentId, props.cwd);
  const readFile = useAtomQueryRunner(projectEnvironment.readFile, {
    reportFailure: false,
    refresh: true,
  });
  const current = useRef(props.source);
  useLayoutEffect(() => {
    current.current = props.source;
  }, [props.source]);
  const sourceBase = latexSourcePathBase(props.source, props.relativePath, props.rootPath);
  const signature = JSON.stringify([
    linkedLatexFiles(props.source, sourceBase),
    bibliographyPaths(props.source, sourceBase),
  ]);
  const [refresh, setRefresh] = useState(0);
  const [index, setIndex] = useState<Omit<SourceProjectIndex, "files" | "pending">>(emptyIndex);
  const [pending, setPending] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      setPending(true);
      void (async () => {
        const next: Omit<SourceProjectIndex, "files" | "pending"> = {
          labels: [],
          citations: [],
          commands: [],
          environments: [],
          unavailable: [],
          limited: false,
        };
        const seen = new Set<string>();
        const queue = [...new Set([props.rootPath, props.relativePath])];
        let bytes = 0;
        while (queue.length && seen.size < 40 && bytes < 2_000_000 && !cancelled) {
          const file = queue.shift()!;
          if (seen.has(file)) continue;
          seen.add(file);
          let source = file === props.relativePath ? current.current : null;
          if (source === null) {
            try {
              const result = await readFile({
                environmentId: props.environmentId,
                input: { cwd: props.cwd, relativePath: file },
              });
              if (result._tag !== "Success" || result.value.truncated) {
                next.unavailable.push(file);
                continue;
              }
              source = result.value.contents;
            } catch {
              next.unavailable.push(file);
              continue;
            }
          }
          bytes += source.length;
          if (bytes > 2_000_000) {
            next.limited = true;
            break;
          }
          if (/\.bib$/iu.test(file)) {
            next.citations.push(...bibliographyChoices(source, file));
            continue;
          }
          if (file !== props.relativePath) {
            const parsed = indexLatexSource(source);
            next.labels.push(
              ...parsed.labels.map((label) => ({
                key: label.key,
                file,
                line: source.slice(0, label.from).split("\n").length,
              })),
            );
            next.commands.push(...parsed.commands);
            next.environments.push(...parsed.customEnvironments);
            next.citations.push(...inlineBibliographyChoices(source));
          }
          const base = latexSourcePathBase(source, file, props.rootPath);
          queue.push(...linkedLatexFiles(source, base), ...bibliographyPaths(source, base));
        }
        next.limited ||= queue.some((file) => !seen.has(file));
        if (!cancelled) {
          setIndex(next);
          setPending(false);
        }
      })();
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [
    props.environmentId,
    props.cwd,
    props.relativePath,
    props.rootPath,
    signature,
    refresh,
    readFile,
  ]);
  const files = useMemo(
    () =>
      (entries.data?.entries ?? [])
        .filter((entry) => entry.kind === "file")
        .map((entry) => entry.path),
    [entries.data],
  );
  return { ...index, files, pending, refresh: () => setRefresh((value) => value + 1) };
}
