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
import { scientSourcesErrorMessage } from "./errorMessage";

type Imports = NonNullable<ScientSourcesOrganizeResult["packageImports"]>;
const evidenceLabel = (item: string) =>
  item.replace(/^note on pin /u, "Note for ").replace(/^pin /u, "Project source ");

export function PackageImportsDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly root: string;
  readonly onImported: () => Promise<unknown>;
  readonly onShowSources?: (sourceIds: ReadonlyArray<string>) => void;
  readonly onClose: () => void;
}) {
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
        if (active) setError(scientSourcesErrorMessage(cause, import.meta.env.DEV));
      });
    return () => {
      active = false;
    };
  }, [environmentId, root]);

  const undo = async (importId: string) => {
    setWorking(true);
    setError(null);
    try {
      const result = await organizeScientSources(environmentId, {
        root,
        change: { action: "undo-import", importId },
      });
      if (result.outcome === "not-found") setError("The import receipt was not found.");
      await props.onImported();
      const listed = await organizeScientSources(environmentId, {
        root,
        change: { action: "list-package-imports" },
      });
      setImports(listed.packageImports ?? []);
      setDiagnostics(listed.packageImportDiagnostics ?? []);
    } catch (cause) {
      setError(scientSourcesErrorMessage(cause, import.meta.env.DEV));
    } finally {
      setWorking(false);
    }
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
          <DialogTitle>Package imports</DialogTitle>
          <DialogDescription>
            Imports into this project. Undo removes unchanged project additions; Library papers and
            joined evidence stay.
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
                ? "Imports could not be read. Close and reopen to try again."
                : "Reading imports…"}
            </p>
          ) : imports.length === 0 ? (
            <p className="text-sm text-muted-foreground">No package imports in this project.</p>
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
                        {new Date(entry.importedAt).toLocaleString()}
                      </p>
                    </div>
                    {entry.canUndo ? (
                      <Button
                        size="xs"
                        variant="outline"
                        disabled={working}
                        onClick={() => void undo(entry.importId)}
                      >
                        Undo
                      </Button>
                    ) : (
                      <span className="text-xs text-muted-foreground">
                        Undone {entry.undoneAt ? new Date(entry.undoneAt).toLocaleString() : ""}
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {entry.added.sources} papers added, {entry.sourcesMatched} already here ·{" "}
                    {entry.added.pdfs} PDFs · {entry.added.pins} added to project ·{" "}
                    {entry.added.collections} collections · {entry.added.reviews} review files
                  </p>
                  {entry.retainedSourceIds.length > 0 ? (
                    <div className="flex items-center gap-2">
                      <p>
                        {entry.retainedSourceIds.length} papers stay in your Library, with their
                        PDFs.
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
                          Show them
                        </Button>
                      ) : null}
                    </div>
                  ) : null}
                  {entry.kept.length > 0 || entry.left.length > 0 ? (
                    <details>
                      <summary className="cursor-pointer">
                        {entry.canUndo ? "What Undo keeps" : "What stayed"}
                      </summary>
                      <ul className="mt-2 list-disc space-y-1 pl-5 break-words">
                        {[...new Set(entry.kept)].map((item) => (
                          <li key={`kept-${item}`}>
                            Changed or used elsewhere: {evidenceLabel(item)}
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
                          Not imported: {failure.item}: {failure.message}
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
