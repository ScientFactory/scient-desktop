import type { ScientLatexToolchainReport } from "@t3tools/contracts";
import { useEffect, useState } from "react";
import { createMarkdownPersistenceTransport } from "../markdownEditor/persistence/markdownPersistenceTransport";
import { markdownPersistenceRegistry } from "../markdownEditor/persistence/markdownPersistenceRegistry";
import { readLatexToolchain } from "./client";
import type { LatexBuildTarget } from "./latexBuildStore";

/** Read the root and environment capabilities without acquiring another document writer. */
export function useLatexDocumentCompiler(input: {
  target: LatexBuildTarget | null;
  selectedPath: string;
  selectedSource: string;
  refreshKey: unknown;
  offline: boolean;
}) {
  const { target } = input;
  const key =
    target === null ? null : `${target.environmentId}\0${target.cwd}\0${target.relativePath}`;
  const environmentId = target?.environmentId ?? null;
  const [root, setRoot] = useState<{
    key: string;
    source: string | null;
    error: string | null;
  } | null>(null);
  const [capabilities, setCapabilities] = useState<{
    environmentId: string;
    report: ScientLatexToolchainReport | null;
    error: string | null;
  } | null>(null);

  useEffect(() => {
    if (!target || key === null || target.relativePath === input.selectedPath) return;
    let disposed = false;
    let sequence = 0;
    const transport = createMarkdownPersistenceTransport(target);
    const update = async () => {
      const issued = ++sequence;
      try {
        const disk = await transport.read();
        if (disposed || issued !== sequence) return;
        const owned = markdownPersistenceRegistry.getTargetSnapshot(target);
        setRoot({
          key,
          source: disk.truncated ? null : (owned?.draftSource ?? disk.source),
          error: disk.truncated
            ? "The root document was only partially read. Open it to review its compiler."
            : null,
        });
      } catch (error) {
        if (!disposed && issued === sequence)
          setRoot({
            key,
            source: null,
            error: error instanceof Error ? error.message : "Could not read the root document.",
          });
      }
    };
    void update();
    const stop = transport.subscribe({
      hint: () => {
        void update();
      },
      connected: (connected) => {
        if (connected) void update();
      },
    });
    const stopOwned = markdownPersistenceRegistry.subscribe(() => {
      const owned = markdownPersistenceRegistry.getTargetSnapshot(target);
      if (owned) setRoot({ key, source: owned.draftSource, error: null });
    });
    return () => {
      disposed = true;
      stop();
      stopOwned();
    };
  }, [target, key, input.selectedPath, input.refreshKey]);

  useEffect(() => {
    if (environmentId === null || input.offline) return;
    let disposed = false;
    void (async () => {
      try {
        const report = await readLatexToolchain(environmentId, { refresh: false });
        if (!disposed) setCapabilities({ environmentId, report, error: null });
      } catch (error) {
        if (!disposed)
          setCapabilities({
            environmentId,
            report: null,
            error:
              error instanceof Error
                ? error.message
                : "Compiler availability could not be checked.",
          });
      }
    })();
    return () => {
      disposed = true;
    };
  }, [environmentId, input.offline, input.refreshKey]);

  const currentRoot = root?.key === key ? root : null;
  const currentCapabilities = capabilities?.environmentId === environmentId ? capabilities : null;
  return {
    source:
      target?.relativePath === input.selectedPath
        ? input.selectedSource
        : (currentRoot?.source ?? null),
    sourceError: currentRoot?.error ?? null,
    report: currentCapabilities?.report ?? null,
    capabilityError: currentCapabilities?.error ?? null,
  };
}
