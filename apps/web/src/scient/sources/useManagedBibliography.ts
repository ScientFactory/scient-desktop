import type {
  EnvironmentId,
  ScientManagedBibliographyFileName,
  ScientManagedBibliographyStatus,
  ScientSourcesOverviewResult,
} from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";

import { useStableCallback } from "~/hooks/useStableCallback";

import { syncScientBibliography } from "./client";
import { publishLibraryVersion } from "./librarySourceRequest";
import { useCanChangeLibrary } from "./sourcesCommands";
import { settleAfter } from "./settleAfter";

/**
 * The server rewrites the managed files after every Library write; this reads
 * the result once the Library the panel shows has changed.
 */
export function useManagedBibliography(input: {
  readonly environmentId: EnvironmentId;
  readonly root: string;
  readonly records: ScientSourcesOverviewResult["records"] | null;
  /** The scope the records are of; switching it changes the rows, not the Library. */
  readonly scope?: string | undefined;
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
  /** The version last seen for each scope here, so the first look at another scope is no change. */
  const seen = useRef<{ readonly context: string; readonly byScope: Map<string, string> } | null>(
    null,
  );
  const scope = input.scope ?? "";

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the managed files live on the server; a Library change there is what makes them worth reading again
  useEffect(() => {
    if (libraryVersion === null) return;
    if (seen.current?.context !== context) seen.current = { context, byScope: new Map() };
    const { byScope } = seen.current;
    const before = byScope.get(scope);
    byScope.set(scope, libraryVersion);
    if (before === libraryVersion || (before === undefined && byScope.size > 1)) return;
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
  }, [canChange, context, input.environmentId, input.root, libraryVersion, scope]);

  const resolve = useStableCallback(
    async (name: ScientManagedBibliographyFileName, action: "replace" | "import") => {
      setReplacing(true);
      await settleAfter(
        async () => {
          const value = await syncScientBibliography(input.environmentId, {
            root: input.root,
            ...(action === "replace" ? { replaceEdited: [name] } : { importEdited: [name] }),
          });
          setStatus({ context, value });
          if (action === "import") input.onImported?.();
        },
        () => setReplacing(false),
      );
    },
  );

  return {
    status: status?.context === context ? status.value : null,
    replacing,
    canChange,
    resolve,
  };
}
