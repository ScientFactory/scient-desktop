import { type ThreadSection, ThreadSectionId, type ThreadSections } from "@t3tools/contracts";
import { useCallback, useMemo } from "react";

import { usePrimarySettings } from "../../hooks/useSettings";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { primaryServerSettingsAtom, serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { randomUUID } from "../../lib/utils";
import {
  type CatalogRenameResult,
  type RemovedSection,
  catalogWithCreatedSection,
  catalogWithRenamedSection,
  catalogWithRestoredSection,
  catalogWithSectionOrder,
  catalogWithoutSection,
  sortThreadSections,
} from "./logic";

// Catalog writes replace the whole list, so they run one at a time and each
// builds on the previous write even before the settings stream echoes it.
let writeQueue: Promise<unknown> = Promise.resolve();
let pendingWrite: { readonly base: ThreadSections; readonly next: ThreadSections } | null = null;

function currentCatalog(): ThreadSections {
  const live = appAtomRegistry.get(primaryServerSettingsAtom).threadSections;
  // A new live value means the stream caught up (or another window wrote).
  if (pendingWrite !== null && pendingWrite.base === live) return pendingWrite.next;
  pendingWrite = null;
  return live;
}

export interface ThreadSectionCatalog {
  /** Sections in display order. */
  readonly sections: readonly ThreadSection[];
  /** False until the primary environment is connected. */
  readonly available: boolean;
  /** Creates a section, or returns the existing one with that name. */
  readonly create: (name: string) => Promise<ThreadSection | null>;
  readonly rename: (sectionId: string, name: string) => Promise<CatalogRenameResult | null>;
  /** Removes the entry; its threads read as unsectioned until it is restored. */
  readonly remove: (sectionId: string) => Promise<RemovedSection | null>;
  readonly restore: (removed: RemovedSection) => Promise<boolean>;
  readonly reorder: (orderedIds: readonly string[]) => Promise<boolean>;
}

export function useThreadSectionCatalog(): ThreadSectionCatalog {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const rawSections = usePrimarySettings((settings) => settings.threadSections);
  const sections = useMemo(() => sortThreadSections(rawSections), [rawSections]);
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    reportFailure: false,
  });

  /** Applies `edit` to the freshest catalog; `edit` returns null to skip the write. */
  const write = useCallback(
    <R>(edit: (catalog: ThreadSections) => { catalog: ThreadSections | null; result: R }) => {
      const run = async (): Promise<{ ok: boolean; result: R | null }> => {
        if (primaryEnvironmentId === null) return { ok: false, result: null };
        const base = appAtomRegistry.get(primaryServerSettingsAtom).threadSections;
        const { catalog, result } = edit(currentCatalog());
        if (catalog === null) return { ok: true, result };
        pendingWrite = { base, next: catalog };
        const outcome = await updateSettings({
          environmentId: primaryEnvironmentId,
          input: { patch: { threadSections: catalog } },
        });
        if (outcome._tag !== "Success") {
          pendingWrite = null;
          return { ok: false, result: null };
        }
        return { ok: true, result };
      };
      const next = writeQueue.then(run, run);
      writeQueue = next;
      return next;
    },
    [primaryEnvironmentId, updateSettings],
  );

  const create = useCallback(
    async (name: string) => {
      const { ok, result } = await write((catalog) => {
        const created = catalogWithCreatedSection(
          catalog,
          name,
          ThreadSectionId.make(randomUUID()),
        );
        return { catalog: created.created ? created.catalog : null, result: created.section };
      });
      return ok ? result : null;
    },
    [write],
  );

  const rename = useCallback(
    async (sectionId: string, name: string) => {
      const { ok, result } = await write((catalog) => {
        const renamed = catalogWithRenamedSection(catalog, sectionId, name);
        return { catalog: renamed.kind === "renamed" ? renamed.catalog : null, result: renamed };
      });
      return ok ? result : null;
    },
    [write],
  );

  const remove = useCallback(
    async (sectionId: string) => {
      const { ok, result } = await write((catalog) => {
        const removed = catalogWithoutSection(catalog, sectionId);
        return { catalog: removed.removed ? removed.catalog : null, result: removed.removed };
      });
      return ok ? result : null;
    },
    [write],
  );

  const restore = useCallback(
    async (removed: RemovedSection) =>
      (
        await write((catalog) => ({
          catalog: catalogWithRestoredSection(catalog, removed),
          result: true,
        }))
      ).ok,
    [write],
  );

  const reorder = useCallback(
    async (orderedIds: readonly string[]) =>
      (
        await write((catalog) => ({
          catalog: catalogWithSectionOrder(catalog, orderedIds),
          result: true,
        }))
      ).ok,
    [write],
  );

  return {
    sections,
    available: primaryEnvironmentId !== null,
    create,
    rename,
    remove,
    restore,
    reorder,
  };
}
