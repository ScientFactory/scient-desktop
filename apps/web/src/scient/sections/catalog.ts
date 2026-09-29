import { useAtomValue } from "@effect/atom-react";
import { type ThreadSection, ThreadSectionId } from "@t3tools/contracts";
import { useCallback, useMemo } from "react";

import { usePrimarySettings } from "../../hooks/useSettings";
import { randomUUID } from "../../lib/utils";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { usePrimaryEnvironmentId } from "../../state/environments";
import {
  environmentServerConfigsAtom,
  primaryServerSettingsAtom,
  serverEnvironment,
} from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  type CatalogRenameResult,
  type RemovedSection,
  type SectionLayout,
  catalogWithCreatedSection,
  catalogWithEnvironments,
  catalogWithRenamedSection,
  catalogWithRestoredSection,
  catalogWithoutSection,
  layoutFromGroupOrder,
  readThreadSections,
  type SectionOccupancy,
  type SectionOrigin,
  sweepEmptySections,
} from "./logic";
import { type CatalogEdit, type LiveLayout, writeCatalog } from "./catalogWrite";

function readLiveLayout(): LiveLayout {
  const settings = appAtomRegistry.get(primaryServerSettingsAtom);
  return { sections: settings.threadSections, generalIndex: settings.threadSectionsGeneralIndex };
}

// Writes run one at a time so this client's edits never race each other.
// Edits from other clients are caught by the server-side precondition below.
let writeQueue: Promise<unknown> = Promise.resolve();

export interface ThreadSectionCatalog {
  /** Sections in display order, General excluded. */
  readonly sections: readonly ThreadSection[];
  /** How many sections precede General. */
  readonly generalIndex: number;
  /** Whether the primary environment is connected and can store sections. */
  readonly available: boolean;
  /** Creates a section, or returns the existing one with that name. */
  readonly create: (name: string, origin?: SectionOrigin) => Promise<ThreadSection | null>;
  readonly rename: (sectionId: string, name: string) => Promise<CatalogRenameResult | null>;
  /** Removes the entry; its threads join General until it is restored. */
  readonly remove: (sectionId: string) => Promise<RemovedSection | null>;
  readonly restore: (removed: RemovedSection) => Promise<boolean>;
  /** Restores sections removed together, each at its old position. */
  readonly restoreAll: (removed: readonly RemovedSection[]) => Promise<boolean>;
  /** Runs one cleanup pass (see `sweepEmptySections`); resolves the sections it removed. */
  readonly sweepEmpty: (input: {
    readonly occupancy: SectionOccupancy;
    readonly visibleEnvironmentIds: ReadonlySet<string> | null;
    readonly afterDays: number;
    readonly isCurrent?: () => boolean;
  }) => Promise<readonly RemovedSection[]>;
  /** Records that these environments hold threads in the section. */
  readonly recordEnvironments: (
    sectionId: string,
    environmentIds: readonly string[],
  ) => Promise<boolean>;
  /** Applies a group order that may include General. */
  readonly reorder: (orderedGroupIds: readonly string[]) => Promise<boolean>;
}

export function useThreadSectionCatalog(): ThreadSectionCatalog {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const serverConfigs = useAtomValue(environmentServerConfigsAtom);
  const rawSections = usePrimarySettings((settings) => settings.threadSections);
  const generalIndex = usePrimarySettings((settings) => settings.threadSectionsGeneralIndex);
  const sections = useMemo(() => readThreadSections(rawSections), [rawSections]);
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    reportFailure: false,
  });
  const available =
    primaryEnvironmentId !== null &&
    serverConfigs.get(primaryEnvironmentId)?.environment.capabilities.threadSections === true;

  /** Applies `edit` to the stored catalog (see `writeCatalog`), one write at a time. */
  const write = useCallback(
    <R>(edit: CatalogEdit<R>) => {
      const run = async (): Promise<{ ok: boolean; result: R | null }> => {
        // A primary that predates sections can't store the catalog.
        if (primaryEnvironmentId === null || !available) return { ok: false, result: null };
        return writeCatalog({
          stored: readLiveLayout(),
          edit,
          send: async (patch) => {
            const outcome = await updateSettings({
              environmentId: primaryEnvironmentId,
              input: { patch },
            });
            if (outcome._tag !== "Success") return null;
            return {
              sections: outcome.value.threadSections,
              generalIndex: outcome.value.threadSectionsGeneralIndex,
            };
          },
        });
      };
      const next = writeQueue.then(run, run);
      writeQueue = next;
      return next;
    },
    [available, primaryEnvironmentId, updateSettings],
  );

  const create = useCallback(
    async (name: string, origin?: SectionOrigin) => {
      const { ok, result } = await write((layout) => {
        const created = catalogWithCreatedSection(
          layout.sections,
          name,
          ThreadSectionId.make(randomUUID()),
          origin,
        );
        return {
          layout: created.changed
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
          needsCurrentLayout: renamed.kind === "missing",
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
        return {
          layout: removed.removed ? removed : null,
          result: removed.removed,
          needsCurrentLayout: removed.removed === null,
        };
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

  const restoreAll = useCallback(
    async (removed: readonly RemovedSection[]) =>
      (
        await write((layout) => {
          let next: SectionLayout = {
            catalog: [...layout.sections],
            generalIndex: layout.generalIndex,
          };
          // Ascending original positions rebuild the list as it was.
          for (const entry of [...removed].toSorted((left, right) => left.index - right.index)) {
            next = catalogWithRestoredSection(next.catalog, entry);
          }
          return { layout: next, result: true };
        })
      ).ok,
    [write],
  );

  const sweepEmpty = useCallback(
    async (input: {
      readonly occupancy: SectionOccupancy;
      readonly visibleEnvironmentIds: ReadonlySet<string> | null;
      readonly afterDays: number;
      readonly isCurrent?: () => boolean;
    }) => {
      const { ok, result } = await write((layout) => {
        if (input.isCurrent?.() === false) return { layout: null, result: [] };
        const swept = sweepEmptySections({
          sections: layout.sections,
          generalIndex: layout.generalIndex,
          now: new Date(),
          ...input,
        });
        return { layout: swept, result: swept?.removed ?? [] };
      });
      return ok ? (result ?? []) : [];
    },
    [write],
  );

  const recordEnvironments = useCallback(
    async (sectionId: string, environmentIds: readonly string[]) => {
      const { ok, result } = await write((layout) => {
        if (!layout.sections.some((section) => section.id === sectionId)) {
          return { layout: null, result: false, needsCurrentLayout: true };
        }
        const catalog = catalogWithEnvironments(layout.sections, sectionId, environmentIds);
        return {
          layout: catalog === null ? null : { catalog, generalIndex: layout.generalIndex },
          result: true,
        };
      });
      return ok && result === true;
    },
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

  return useMemo(
    () => ({
      sections,
      generalIndex,
      available,
      create,
      rename,
      remove,
      restore,
      restoreAll,
      sweepEmpty,
      recordEnvironments,
      reorder,
    }),
    [
      available,
      create,
      generalIndex,
      recordEnvironments,
      remove,
      rename,
      reorder,
      restore,
      restoreAll,
      sections,
      sweepEmpty,
    ],
  );
}
