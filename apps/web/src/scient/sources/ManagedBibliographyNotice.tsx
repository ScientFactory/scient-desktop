import type { ScientManagedBibliographyFileStatus } from "@t3tools/contracts";
import { msg, T, useGT, useMessages } from "gt-react";

import { m, type MessageResolver } from "~/i18n/messages";

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

function changeSummary(
  file: ScientManagedBibliographyFileStatus,
  resolve: MessageResolver,
): string {
  const changes = file.changes;
  if (!changes) return "";
  const parts = [
    changes.added.length > 0
      ? resolve(
          msg("{count} added", { count: changes.added.length, $context: "bibliography entries" }),
        )
      : null,
    changes.changed.length > 0
      ? resolve(
          msg("{count} changed", {
            count: changes.changed.length,
            $context: "bibliography entries",
          }),
        )
      : null,
    changes.removed.length > 0
      ? resolve(
          msg("{count} removed", {
            count: changes.removed.length,
            $context: "bibliography entries",
          }),
        )
      : null,
  ].filter((part): part is string => part !== null);
  return parts.length > 0 ? parts.join(", ") : "";
}

function keptSummary(
  file: ScientManagedBibliographyFileStatus,
  failed: boolean,
  resolve: MessageResolver,
): string | null {
  const kept = file.kept ?? [];
  if (kept.length === 0) return null;
  const values = { name: file.name, files: kept.join(", "), count: kept.length };
  return failed
    ? resolve(
        msg(
          "{count, plural, one {{name} could not be written. Its earlier text is kept in {files}; delete it once you no longer need it.} other {{name} could not be written. Its earlier text is kept in {files}; delete them once you no longer need them.}}",
          values,
        ),
      )
    : resolve(
        msg(
          "{count, plural, one {Earlier text of {name} is kept in {files}; delete it once you no longer need it.} other {Earlier text of {name} is kept in {files}; delete them once you no longer need them.}}",
          values,
        ),
      );
}

/** Each managed bibliography file that needs a decision, or whose earlier text is kept. */
function ManagedBibliographyNotice(props: ManagedBibliographyProps) {
  const gt = useGT();
  const m = useMessages();
  const attention = props.files.filter(needsAttention);
  if (attention.length === 0) return null;
  const replaceButton = (file: ScientManagedBibliographyFileStatus) => (
    <Button
      size="xs"
      variant="ghost"
      disabled={props.replacing}
      onClick={() => props.onResolve(file.name, "replace")}
    >
      <T>Use Library version</T>
    </Button>
  );
  return (
    <div className="space-y-2 text-xs text-muted-foreground">
      {attention.map((file) => {
        // An edited file with nothing to compare is one a failed write moved aside.
        const failed =
          file.state === "edited" && file.changes === null && Boolean(file.kept?.length);
        const kept = keptSummary(file, failed, m);
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
                  {changeSummary(file, m)
                    ? gt("{name} was edited outside Scient ({changes}). Your edits are kept.", {
                        name: file.name,
                        changes: changeSummary(file, m),
                      })
                    : gt("{name} was edited outside Scient. Your edits are kept.", {
                        name: file.name,
                      })}
                </span>
                {file.changes && file.changes.added.length > 0 ? (
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={props.replacing}
                    onClick={() => props.onResolve(file.name, "import")}
                  >
                    <T>Import new entries</T>
                  </Button>
                ) : null}
                {replaceButton(file)}
              </div>
            ) : file.state === "unmanaged" ? (
              <div>
                {gt("{name} was not written by Scient, so the Library is not saved to it.", {
                  name: file.name,
                })}
              </div>
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
  resolve: MessageResolver = m,
): SourcesActivityItem | null {
  const attention = props.files.filter(needsAttention);
  if (attention.length === 0) return null;
  const edited = attention.some((file) => file.state === "edited");
  return {
    key: "managed-bibliography",
    tone: edited ? "decision" : "advisory",
    label: edited
      ? resolve(msg("A bibliography file was edited outside Scient"))
      : attention.some((file) => file.state === "unmanaged")
        ? resolve(msg("A bibliography file was not written by Scient"))
        : resolve(msg("Earlier bibliography text is kept")),
    body: <ManagedBibliographyNotice {...props} />,
  };
}
