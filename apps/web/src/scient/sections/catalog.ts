import { type ThreadSection, ThreadSectionId } from "@t3tools/contracts";
import { useCallback, useMemo } from "react";

import { usePrimarySettings } from "../../hooks/useSettings";
import { randomUUID } from "../../lib/utils";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { primaryServerSettingsAtom, serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  type CatalogRenameResult,
  type RemovedSection,
  type SectionLayout,
  catalogWithCreatedSection,
  catalogWithRenamedSection,
  catalogWithRestoredSection,
  catalogWithoutSection,
  layoutFromGroupOrder,
  sortThreadSections,
} from "./logic";

type LiveLayout = { readonly sections: readonly ThreadSection[]; readonly generalIndex: number };

function readLiveLayout(): LiveLayout {
  const settings = appAtomRegistry.get(primaryServerSettingsAtom);
  return { sections: settings.threadSections, generalIndex: settings.threadSectionsGeneralIndex };
}

// Layout writes replace the whole catalog, so they run one at a time and each
// builds on the previous write even before the settings stream echoes it.
let writeQueue: Promise<unknown> = Promise.resolve();
let pendingWrite: {
  readonly base: readonly ThreadSection[];
  readonly next: SectionLayout;
} | null = null;

function currentLayout(): LiveLayout {
  const live = readLiveLayout();
  // A new live catalog means the stream caught up (or another window wrote).
  if (pendingWrite !== null && pendingWrite.base === live.sections) {
    return { sections: pendingWrite.next.catalog, generalIndex: pendingWrite.next.generalIndex };
  }
  pendingWrite = null;
  return live;
}

export interface ThreadSectionCatalog {
  /** Sections in display order, General excluded. */
  readonly sections: readonly ThreadSection[];
  /** How many sections precede General. */
  readonly generalIndex: number;
  /** False until the primary environment is connected. */
  readonly available: boolean;
  /** Creates a section, or returns the existing one with that name. */
  readonly create: (name: string) => Promise<ThreadSection | null>;
  readonly rename: (sectionId: string, name: string) => Promise<CatalogRenameResult | null>;
  /** Removes the entry; its threads join General until it is restored. */
  readonly remove: (sectionId: string) => Promise<RemovedSection | null>;
  readonly restore: (removed: RemovedSection) => Promise<boolean>;
  /** Applies a group order that may include General. */
  readonly reorder: (orderedGroupIds: readonly string[]) => Promise<boolean>;
}

export function useThreadSectionCatalog(): ThreadSectionCatalog {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const rawSections = usePrimarySettings((settings) => settings.threadSections);
  const generalIndex = usePrimarySettings((settings) => settings.threadSectionsGeneralIndex);
  const sections = useMemo(() => sortThreadSections(rawSections), [rawSections]);
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    reportFailure: false,
  });

  /** Applies `edit` to the freshest layout; `edit` returns a null layout to skip the write. */
  const write = useCallback(
    <R>(edit: (layout: LiveLayout) => { layout: SectionLayout | null; result: R }) => {
      const run = async (): Promise<{ ok: boolean; result: R | null }> => {
        if (primaryEnvironmentId === null) return { ok: false, result: null };
        const base = readLiveLayout().sections;
        const { layout, result } = edit(currentLayout());
        if (layout === null) return { ok: true, result };
        pendingWrite = { base, next: layout };
        const outcome = await updateSettings({
          environmentId: primaryEnvironmentId,
          input: {
            patch: {
              threadSections: layout.catalog,
              threadSectionsGeneralIndex: layout.generalIndex,
            },
          },
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
      const { ok, result } = await write((layout) => {
        const created = catalogWithCreatedSection(
          layout.sections,
          name,
          ThreadSectionId.make(randomUUID()),
        );
        return {
          layout: created.created
            ? { catalog: created.catalog, generalIndex: layout.generalIndex }
            : null,
          result: created.section,
        };
      });
      return ok ? result : null;
    },
    [write],
  );

  const rename = useCallback(
    async (sectionId: string, name: string) => {
      const { ok, result } = await write((layout) => {
        const renamed = catalogWithRenamedSection(layout.sections, sectionId, name);
        return {
          layout:
            renamed.kind === "renamed"
              ? { catalog: renamed.catalog, generalIndex: layout.generalIndex }
              : null,
          result: renamed,
        };
      });
      return ok ? result : null;
    },
    [write],
  );

  const remove = useCallback(
    async (sectionId: string) => {
      const { ok, result } = await write((layout) => {
        const removed = catalogWithoutSection(layout.sections, layout.generalIndex, sectionId);
        return { layout: removed.removed ? removed : null, result: removed.removed };
      });
      return ok ? result : null;
    },
    [write],
  );

  const restore = useCallback(
    async (removed: RemovedSection) =>
      (
        await write((layout) => ({
          layout: catalogWithRestoredSection(layout.sections, removed),
          result: true,
        }))
      ).ok,
    [write],
  );

  const reorder = useCallback(
    async (orderedGroupIds: readonly string[]) =>
      (
        await write((layout) => ({
          layout: layoutFromGroupOrder(layout.sections, orderedGroupIds),
          result: true,
        }))
      ).ok,
    [write],
  );

  return {
    sections,
    generalIndex,
    available: primaryEnvironmentId !== null,
    create,
    rename,
    remove,
    restore,
    reorder,
  };
}
