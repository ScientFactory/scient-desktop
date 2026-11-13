import type { EnvironmentId, ScientSourcesOrganizeResult } from "@t3tools/contracts";
import { Package } from "lucide-react";
import { useState } from "react";

import {
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuItemDetail,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
} from "../../components/ui/menu";
import { toastManager } from "../../components/ui/toast";
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
  return `${plural(report.sources, "source", "sources")}, ${plural(report.pdfs, "PDF", "PDFs")}, ${plural(report.reviews, "review", "reviews")}.${unavailable}`;
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
  const conflicts = report.reviewConflicts
    ? ` ${plural(report.reviewConflicts, "review differs", "reviews differ")}: choose a version in Systematic reviews.`
    : "";
  return `${parts.join(", ")}.${notes}${conflicts}`;
}

/** Export this project's package to a project folder, or import one found in the project. */
export function ProjectPackageSubmenu(props: {
  readonly environmentId: EnvironmentId;
  readonly root: string;
  readonly onImported: () => Promise<unknown>;
}) {
  const [packages, setPackages] = useState<PackageListing | null>(null);
  const [working, setWorking] = useState(false);

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

  const exportPackage = () =>
    run(async () => {
      const result = await organize({ action: "export-package" });
      toastManager.add({
        type: "success",
        title: `Saved the project package to ${result.packagePath ?? "the project"}`,
        ...(result.packageReport ? { description: exportedDescription(result.packageReport) } : {}),
      });
    }, "The project package was not saved");

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
      toastManager.add({
        type: "success",
        title: `Imported ${relativePath}`,
        ...(result.packageReport ? { description: importedDescription(result.packageReport) } : {}),
      });
    }, "The project package was not imported");

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
        Project package
      </MenuSubTrigger>
      <MenuSubPopup className="min-w-56">
        <MenuItem onClick={() => void exportPackage()}>Save a project package</MenuItem>
        <MenuSeparator />
        <MenuGroup>
          <MenuGroupLabel>Import a package in this project</MenuGroupLabel>
          {packages === null ? (
            <MenuItem disabled>Looking for packages…</MenuItem>
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
