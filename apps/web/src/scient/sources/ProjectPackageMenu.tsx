import type { EnvironmentId, ScientSourcesOrganizeResult } from "@t3tools/contracts";
import { Package, Undo2 } from "lucide-react";
import { useState } from "react";

import {
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuItemDetail,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
} from "../../components/ui/menu";
import { toastManager } from "../../components/ui/toast";
import { readLocalApi } from "../../localApi";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { organizeScientSources } from "./client";

type PackageListing = NonNullable<ScientSourcesOrganizeResult["packages"]>;
type PackageReport = NonNullable<ScientSourcesOrganizeResult["packageReport"]>;

const plural = (value: number, one: string, many: string) =>
  `${value.toLocaleString()} ${value === 1 ? one : many}`;

const message = (cause: unknown) =>
  cause instanceof Error ? cause.message : "Something went wrong.";

function exportedDescription(report: PackageReport): string {
  const unavailable =
    report.unavailable > 0
      ? ` ${plural(report.unavailable, "PDF or source was", "PDFs or sources were")} not in this Library.`
      : "";
  const inside = report.insideProject
    ? " It is in the project folder, so Git commits it with the project and it takes disk space there."
    : "";
  return `${plural(report.sources, "source", "sources")}, ${plural(report.pdfs, "PDF", "PDFs")}, ${plural(report.reviews, "review", "reviews")}.${unavailable}${inside}`;
}

function importedDescription(report: PackageReport): string {
  const parts = [
    `${plural(report.sources, "source", "sources")} added, ${(report.sourcesMatched ?? 0).toLocaleString()} already here`,
    plural(report.pdfs, "PDF", "PDFs"),
    plural(report.reviews, "review", "reviews"),
  ];
  const notes = report.notesKept
    ? ` ${plural(report.notesKept, "note here was", "notes here were")} kept; the package's version is in Earlier versions.`
    : "";
  const highlights = report.annotationConflicts
    ? ` ${plural(report.annotationConflicts, "highlight was", "highlights were")} changed on both computers; yours stays, theirs is in its history.`
    : "";
  const conflicts = report.reviewConflicts
    ? ` ${plural(report.reviewConflicts, "review differs", "reviews differ")}: choose a version in Systematic reviews.`
    : "";
  const unavailable =
    report.unavailable > 0
      ? ` ${plural(report.unavailable, "PDF or source was", "PDFs or sources were")} not in the package.`
      : "";
  const failed = report.failed?.length
    ? ` ${plural(report.failed.length, "part", "parts")} could not be imported: ${report.failed.map((entry) => entry.item).join(", ")}.`
    : "";
  return `${parts.join(", ")}.${notes}${highlights}${conflicts}${unavailable}${failed}`;
}

/** The folder above the project, where a package goes by default. */
function parentOf(root: string): string {
  return root.replace(/[\\/]+$/u, "").replace(/[\\/][^\\/]+$/u, "") || root;
}

/** Save this project's package where the person chooses, or import one. */
export function ProjectPackageSubmenu(props: {
  readonly environmentId: EnvironmentId;
  readonly root: string;
  readonly onImported: () => Promise<unknown>;
  readonly mode: "recover" | "import";
  readonly onMoveBack?: () => void;
  readonly onOpenImports?: () => void;
  readonly onShowSources?: (sourceIds: ReadonlyArray<string>) => void;
}) {
  const [packages, setPackages] = useState<PackageListing | null>(null);
  const [working, setWorking] = useState(false);
  // A chosen folder names this computer's files, so only the local environment can use one.
  const local = props.environmentId === usePrimaryEnvironmentId();
  const pickFolder = local && window.desktopBridge ? readLocalApi()?.dialogs.pickFolder : undefined;

  const organize = (change: Parameters<typeof organizeScientSources>[1]["change"]) =>
    organizeScientSources(props.environmentId, { root: props.root, change });

  const run = async (task: () => Promise<void>, failure: string) => {
    setWorking(true);
    try {
      await task();
    } catch (cause) {
      toastManager.add({ type: "error", title: failure, description: message(cause) });
    } finally {
      setWorking(false);
    }
  };

  const exportPackage = (inFolder?: string) =>
    run(async () => {
      const result = await organize({
        action: "export-package",
        ...(inFolder ? { inFolder } : {}),
      });
      toastManager.add({
        type: "success",
        title: `Saved the project package to ${result.packagePath ?? "the project"}`,
        ...(result.packageReport ? { description: exportedDescription(result.packageReport) } : {}),
      });
    }, "The project package was not saved");

  const exportElsewhere = async (pick: NonNullable<typeof pickFolder>) => {
    const folder = await pick({ initialPath: parentOf(props.root) }).catch(() => null);
    if (folder) await exportPackage(folder);
  };

  const undoImport = (importId: string) =>
    run(async () => {
      const result = await organize({ action: "undo-import", importId });
      await props.onImported();
      if (result.outcome !== "undone") {
        toastManager.add({
          type: "info",
          title:
            result.outcome === "already-undone"
              ? "That import was already undone"
              : "The import receipt was not found",
        });
        return;
      }
      const kept = result.packageReport?.kept ?? [];
      const left = result.packageReport?.left ?? [];
      const retained = result.packageReport?.retainedSourceIds ?? [];
      const description = [
        `${plural(retained.length, "paper stays", "papers stay")} in your Library, with their PDFs.`,
        kept.length > 0
          ? `Changed since or used by another import, so kept: ${kept.join(", ")}.`
          : "",
        left.length > 0
          ? `Left as evidence: ${plural(left.length, "item", "items")}. See Recover → Package imports for the full list.`
          : "",
      ]
        .filter(Boolean)
        .join(" ");
      toastManager.add({
        type: "success",
        title: "Import undone",
        ...(description ? { description } : {}),
        ...(retained.length > 0 && props.onShowSources
          ? {
              actionProps: {
                children: "Show them",
                onClick: () => props.onShowSources?.(retained),
              },
            }
          : {}),
      });
    }, "The import was not undone");

  const importPackage = (relativePath: string) =>
    run(async () => {
      const result = await organize({ action: "import-package", relativePath });
      if (result.outcome === "package-changed") {
        toastManager.add({
          type: "error",
          title: "Not imported: files in the package changed after it was saved",
        });
        return;
      }
      if (result.outcome === "not-a-package") {
        toastManager.add({ type: "error", title: `${relativePath} is not a project package` });
        return;
      }
      await props.onImported();
      const report = result.packageReport;
      const importId = report?.importId;
      const id = toastManager.add({
        type: report?.failed?.length ? "warning" : "success",
        title: `Imported ${relativePath}`,
        ...(report ? { description: importedDescription(report) } : {}),
        ...(importId
          ? {
              actionProps: {
                children: "Undo",
                onClick: () => {
                  toastManager.close(id);
                  void undoImport(importId);
                },
              },
            }
          : {}),
      });
    }, "The project package was not imported");

  const importChosen = async (pick: NonNullable<typeof pickFolder>) => {
    const folder = await pick({ initialPath: parentOf(props.root) }).catch(() => null);
    if (folder) await importPackage(folder);
  };

  if (props.mode === "recover")
    return (
      <MenuSub>
        <MenuSubTrigger disabled={working}>
          <Undo2 />
          Recover
        </MenuSubTrigger>
        <MenuSubPopup>
          <MenuItem
            onClick={() =>
              void run(async () => {
                const result = await organize({ action: "restore-pre-move" });
                await props.onImported();
                toastManager.add({
                  type: result.outcome === "archive-changed" ? "error" : "info",
                  title:
                    result.outcome === "restored"
                      ? "Recovered sources from before the move"
                      : result.outcome === "no-archive"
                        ? "No pre-move copy was found"
                        : result.outcome === "project-store-present"
                          ? "Sources are already in this project's folder"
                          : "The pre-move copy changed and was not recovered",
                });
              }, "Sources could not be recovered")
            }
          >
            Recover sources from before the move
          </MenuItem>
          <MenuItem onClick={props.onOpenImports}>Package imports</MenuItem>
          <MenuItem disabled={!props.onMoveBack} onClick={props.onMoveBack}>
            Keep this project's sources in its folder
          </MenuItem>
          <MenuItem
            onClick={() => void (pickFolder ? exportElsewhere(pickFolder) : exportPackage())}
          >
            Save a current package
          </MenuItem>
        </MenuSubPopup>
      </MenuSub>
    );

  return (
    <MenuSub
      onOpenChange={(open) => {
        if (!open) return;
        void organize({ action: "list-packages" })
          .then((result) => setPackages(result.packages ?? []))
          .catch(() => setPackages([]));
      }}
    >
      <MenuSubTrigger disabled={working}>
        <Package />
        Import a package
      </MenuSubTrigger>
      <MenuSubPopup className="min-w-56">
        <MenuGroup>
          <MenuGroupLabel>Import a package</MenuGroupLabel>
          {pickFolder ? (
            <MenuItem onClick={() => void importChosen(pickFolder)}>Choose a folder…</MenuItem>
          ) : null}
          {packages === null ? (
            <MenuItem disabled>Looking in this project…</MenuItem>
          ) : packages.length === 0 ? (
            <MenuItem disabled>No package folder in this project</MenuItem>
          ) : (
            packages.map((entry) => (
              <MenuItem
                key={entry.relativePath}
                onClick={() => void importPackage(entry.relativePath)}
              >
                <span className="min-w-0 flex-1 truncate">{entry.relativePath}</span>
                <MenuItemDetail>
                  {new Date(entry.exportedAt).toLocaleDateString(undefined, {
                    dateStyle: "medium",
                  })}
                </MenuItemDetail>
              </MenuItem>
            ))
          )}
        </MenuGroup>
      </MenuSubPopup>
    </MenuSub>
  );
}
