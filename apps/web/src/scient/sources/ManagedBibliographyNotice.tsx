import type { ScientManagedBibliographyFileStatus } from "@t3tools/contracts";

import { Button } from "../../components/ui/button";
import type { SourcesActivityItem } from "./sourcesFeedback";

interface ManagedBibliographyProps {
  readonly files: ReadonlyArray<ScientManagedBibliographyFileStatus>;
  readonly replacing: boolean;
  readonly onResolve: (
    name: ScientManagedBibliographyFileStatus["name"],
    action: "replace" | "import",
  ) => void;
}

const needsAttention = (file: ScientManagedBibliographyFileStatus) =>
  file.state === "edited" || file.state === "unmanaged" || (file.kept?.length ?? 0) > 0;

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

/** Each managed bibliography file that needs a decision, or whose earlier text is kept. */
function ManagedBibliographyNotice(props: ManagedBibliographyProps) {
  const attention = props.files.filter(needsAttention);
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
    <div className="space-y-2 text-xs text-muted-foreground">
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

/**
 * An edited file waits for the person's choice until resolved; a file Scient did not write, or
 * earlier text kept beside one, is worth knowing until the file or its kept copies change.
 */
export function managedBibliographyActivity(
  props: ManagedBibliographyProps,
): SourcesActivityItem | null {
  const attention = props.files.filter(needsAttention);
  if (attention.length === 0) return null;
  const edited = attention.some((file) => file.state === "edited");
  return {
    key: "managed-bibliography",
    tone: edited ? "decision" : "advisory",
    label: edited
      ? "A bibliography file was edited outside Scient"
      : attention.some((file) => file.state === "unmanaged")
        ? "A bibliography file was not written by Scient"
        : "Earlier bibliography text is kept",
    body: <ManagedBibliographyNotice {...props} />,
  };
}
