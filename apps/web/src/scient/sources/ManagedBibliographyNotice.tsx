import type { ScientManagedBibliographyFileStatus } from "@t3tools/contracts";

import { Button } from "../../components/ui/button";

function changeSummary(file: ScientManagedBibliographyFileStatus): string {
  const changes = file.changes;
  if (!changes) return "";
  const parts = [
    changes.added.length > 0 ? `${changes.added.length} added` : null,
    changes.changed.length > 0 ? `${changes.changed.length} changed` : null,
    changes.removed.length > 0 ? `${changes.removed.length} removed` : null,
  ].filter((part): part is string => part !== null);
  return parts.length > 0 ? ` (${parts.join(", ")})` : "";
}

function keptSummary(file: ScientManagedBibliographyFileStatus, failed: boolean): string | null {
  const kept = file.kept ?? [];
  if (kept.length === 0) return null;
  const them = kept.length === 1 ? "it" : "them";
  return failed
    ? `${file.name} could not be written. Its earlier text is kept in ${kept.join(", ")}; delete ${them} once you no longer need ${them}.`
    : `Earlier text of ${file.name} is kept in ${kept.join(", ")}; delete ${them} once you no longer need ${them}.`;
}

/** Shown only when a managed bibliography file needs a decision. */
export function ManagedBibliographyNotice(props: {
  readonly files: ReadonlyArray<ScientManagedBibliographyFileStatus>;
  readonly replacing: boolean;
  readonly onResolve: (
    name: ScientManagedBibliographyFileStatus["name"],
    action: "replace" | "import",
  ) => void;
}) {
  const attention = props.files.filter(
    (file) => file.state === "edited" || file.state === "unmanaged" || (file.kept?.length ?? 0) > 0,
  );
  if (attention.length === 0) return null;
  const replaceButton = (file: ScientManagedBibliographyFileStatus) => (
    <Button
      size="xs"
      variant="ghost"
      disabled={props.replacing}
      onClick={() => props.onResolve(file.name, "replace")}
    >
      Use Library version
    </Button>
  );
  return (
    <div className="mx-3 mt-3 space-y-2 rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
      {attention.map((file) => {
        // An edited file with nothing to compare is one a failed write moved aside.
        const failed =
          file.state === "edited" && file.changes === null && Boolean(file.kept?.length);
        const kept = keptSummary(file, failed);
        if (failed) {
          return (
            <div key={file.name} className="flex items-center gap-2">
              <span className="min-w-0 flex-1 break-words">{kept}</span>
              {replaceButton(file)}
            </div>
          );
        }
        return (
          <div key={file.name} className="space-y-2">
            {file.state === "edited" ? (
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1">
                  {file.name} was edited outside Scient{changeSummary(file)}. Your edits are kept.
                </span>
                {file.changes && file.changes.added.length > 0 ? (
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={props.replacing}
                    onClick={() => props.onResolve(file.name, "import")}
                  >
                    Import new entries
                  </Button>
                ) : null}
                {replaceButton(file)}
              </div>
            ) : file.state === "unmanaged" ? (
              <div>{file.name} was not written by Scient, so the Library is not saved to it.</div>
            ) : null}
            {kept ? <div className="break-words">{kept}</div> : null}
          </div>
        );
      })}
    </div>
  );
}
