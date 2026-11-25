import { T, useGT, useMessages, Var } from "gt-react";
import type { EnvironmentId, ScientSourcesOrganizeResult } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../../components/ui/dialog";
import { organizeScientSources } from "./client";
import { whenLabel } from "./dayLabel";
import { sourcesErrorMessage } from "./errorMessage";
import { settleAfter } from "./settleAfter";

type Imports = NonNullable<ScientSourcesOrganizeResult["packageImports"]>;
const evidenceLabel = (item: string) =>
  item.replace(/^note on pin /u, "Note for ").replace(/^pin /u, "Project source ");

/** Opened from Recent changes: each package imported into this project, with Undo. */
export function PackageImportsDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly root: string;
  /** False for a session that may only read: the imports show, without Undo. */
  readonly canChange: boolean;
  readonly onImported: () => Promise<unknown>;
  readonly onShowSources?: (sourceIds: ReadonlyArray<string>) => void;
  readonly onClose: () => void;
}) {
  const gt = useGT();
  const m = useMessages();
  const [imports, setImports] = useState<Imports | null>(null);
  const [diagnostics, setDiagnostics] = useState<ReadonlyArray<string>>([]);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const { environmentId, root } = props;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads durable receipts when the recovery dialog opens
  useEffect(() => {
    let active = true;
    void organizeScientSources(environmentId, { root, change: { action: "list-package-imports" } })
      .then((result) => {
        if (active) {
          setImports(result.packageImports ?? []);
          setDiagnostics(result.packageImportDiagnostics ?? []);
        }
      })
      .catch((cause: unknown) => {
        if (active) setError(sourcesErrorMessage(cause));
      });
    return () => {
      active = false;
    };
  }, [environmentId, root]);

  const undo = async (importId: string) => {
    setWorking(true);
    setError(null);
    await settleAfter(
      async () => {
        try {
          const result = await organizeScientSources(environmentId, {
            root,
            change: { action: "undo-import", importId },
          });
          if (result.outcome === "not-found") setError(gt("The import receipt was not found."));
          await props.onImported();
          const listed = await organizeScientSources(environmentId, {
            root,
            change: { action: "list-package-imports" },
          });
          setImports(listed.packageImports ?? []);
          setDiagnostics(listed.packageImportDiagnostics ?? []);
        } catch (cause) {
          setError(sourcesErrorMessage(cause));
        }
      },
      () => setWorking(false),
    );
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            <T>Package imports</T>
          </DialogTitle>
          <DialogDescription>
            <T>
              Packages imported into this project. Undo takes out what an import added and nobody
              changed since; its papers stay in My Library.
            </T>
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {diagnostics.length > 0 ? (
            <ul role="status" className="list-disc pl-5 text-sm text-muted-foreground">
              {diagnostics.map((message) => (
                <li key={message}>{message}</li>
              ))}
            </ul>
          ) : null}
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          {imports === null ? (
            <p role="status">
              {error
                ? gt("Imports could not be read. Close and reopen to try again.")
                : gt("Reading imports…")}
            </p>
          ) : imports.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              <T>No package imports in this project.</T>
            </p>
          ) : (
            <div className="space-y-4">
              {imports.map((entry) => (
                <section
                  key={entry.importId}
                  aria-label={entry.packageTitle}
                  className="space-y-2 border-b border-border pb-4 text-sm"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="break-words font-medium">{entry.packageTitle}</p>
                      <p className="text-xs text-muted-foreground">
                        {whenLabel(entry.importedAt, m)}
                      </p>
                    </div>
                    {entry.canUndo && props.canChange ? (
                      <Button
                        size="xs"
                        variant="outline"
                        disabled={working}
                        onClick={() => void undo(entry.importId)}
                      >
                        <T context="verb, button that undoes a change">Undo</T>
                      </Button>
                    ) : entry.canUndo ? null : (
                      <span className="text-xs text-muted-foreground">
                        <T>
                          Undone <Var>{entry.undoneAt ? whenLabel(entry.undoneAt, m) : ""}</Var>
                        </T>
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    <T>
                      <Var>{entry.added.sources}</Var> papers added,{" "}
                      <Var>{entry.sourcesMatched}</Var> already here · <Var>{entry.added.pdfs}</Var>{" "}
                      PDFs · <Var>{entry.added.pins}</Var> added to project ·{" "}
                      <Var>{entry.added.collections}</Var> collections ·{" "}
                      <Var>{entry.added.reviews}</Var> review files
                    </T>
                  </p>
                  {entry.retainedSourceIds.length > 0 ? (
                    <div className="flex items-center gap-2">
                      <p>
                        <T>
                          <Var>{entry.retainedSourceIds.length}</Var> papers stay in My Library,
                          with their PDFs.
                        </T>
                      </p>
                      {props.onShowSources ? (
                        <Button
                          size="xs"
                          variant="ghost"
                          onClick={() => {
                            props.onShowSources?.(entry.retainedSourceIds);
                            props.onClose();
                          }}
                        >
                          <T>Show them</T>
                        </Button>
                      ) : null}
                    </div>
                  ) : null}
                  {entry.kept.length > 0 || entry.left.length > 0 ? (
                    <details>
                      <summary className="cursor-pointer">
                        {entry.canUndo ? gt("What Undo keeps") : gt("What stayed")}
                      </summary>
                      <ul className="mt-2 list-disc space-y-1 pl-5 break-words">
                        {[...new Set(entry.kept)].map((item) => (
                          <li key={`kept-${item}`}>
                            <T>
                              Changed or used elsewhere: <Var>{evidenceLabel(item)}</Var>
                            </T>
                          </li>
                        ))}
                        {[...new Set(entry.left)].map((item) => (
                          <li key={`left-${item}`}>{evidenceLabel(item)}</li>
                        ))}
                      </ul>
                    </details>
                  ) : null}
                  {entry.failed.length > 0 ? (
                    <ul className="list-disc pl-5 break-words">
                      {entry.failed.map((failure) => (
                        <li key={JSON.stringify(failure)}>
                          <T>
                            Not imported: <Var>{failure.item}</Var>: <Var>{failure.message}</Var>
                          </T>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </section>
              ))}
            </div>
          )}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
