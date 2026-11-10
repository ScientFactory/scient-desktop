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

/**
 * The server rewrites the managed files after every Library write; this reads
 * the result once the Library the panel shows has changed.
 */
export function useManagedBibliography(input: {
  readonly environmentId: EnvironmentId;
  readonly root: string;
  readonly records: ScientSourcesOverviewResult["records"] | null;
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

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the managed files live on the server; a Library change there is what makes them worth reading again
  useEffect(() => {
    if (libraryVersion === null) return;
    publishLibraryVersion(input.root, libraryVersion);
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
  }, [context, input.environmentId, input.root, libraryVersion]);

  const replace = useStableCallback(async (name: ScientManagedBibliographyFileName) => {
    setReplacing(true);
    try {
      const value = await syncScientBibliography(input.environmentId, {
        root: input.root,
        replaceEdited: [name],
      });
      setStatus({ context, value });
    } finally {
      setReplacing(false);
    }
  });

  return {
    status: status?.context === context ? status.value : null,
    replacing,
    replace,
  };
}
