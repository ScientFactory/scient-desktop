import type {
  EnvironmentId,
  ScientManagedBibliographyFileName,
  ScientManagedBibliographyStatus,
  ScientSourcesOverviewResult,
} from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { useStableCallback } from "~/hooks/useStableCallback";

import { syncScientBibliography } from "./client";
import { publishLibraryVersion } from "./librarySourceRequest";
import { useCanChangeLibrary } from "./sourcesCommands";

/**
 * The server rewrites the managed files after every Library write; this reads
 * the result once the Library the panel shows has changed.
 */
export function useManagedBibliography(input: {
  readonly environmentId: EnvironmentId;
  readonly root: string;
  readonly records: ScientSourcesOverviewResult["records"] | null;
  /** Called after hand-edited entries were imported, so the Library list can refresh. */
  readonly onImported?: () => void;
}) {
  const libraryVersion = input.records
    ? `${input.records.length}:${input.records.reduce((latest, record) => {
        const changed = record.updatedAt ?? record.importedAt;
        return changed > latest ? changed : latest;
      }, "")}`
    : null;
  const [status, setStatus] = useState<{
    readonly context: string;
    readonly value: ScientManagedBibliographyStatus;
  } | null>(null);
  const [replacing, setReplacing] = useState(false);
  const context = `${input.environmentId}\0${input.root}`;
  const canChange = useCanChangeLibrary(input.environmentId);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the managed files live on the server; a Library change there is what makes them worth reading again
  useEffect(() => {
    if (libraryVersion === null) return;
    publishLibraryVersion(input.root, libraryVersion);
    if (!canChange) return;
    let current = true;
    Promise.resolve()
      .then(() => syncScientBibliography(input.environmentId, { root: input.root }))
      .then(
        (value) => {
          if (current) setStatus({ context, value });
        },
        () => undefined,
      );
    return () => {
      current = false;
    };
  }, [canChange, context, input.environmentId, input.root, libraryVersion]);

  const resolve = useStableCallback(
    async (name: ScientManagedBibliographyFileName, action: "replace" | "import") => {
      setReplacing(true);
      try {
        const value = await syncScientBibliography(input.environmentId, {
          root: input.root,
          ...(action === "replace" ? { replaceEdited: [name] } : { importEdited: [name] }),
        });
        setStatus({ context, value });
        if (action === "import") input.onImported?.();
      } finally {
        setReplacing(false);
      }
    },
  );

  return {
    status: status?.context === context ? status.value : null,
    replacing,
    canChange,
    resolve,
  };
}
