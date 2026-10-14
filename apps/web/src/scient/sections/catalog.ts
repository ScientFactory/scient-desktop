import { useAtomValue } from "@effect/atom-react";
import { EnvironmentId, type ThreadSection, ThreadSectionId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { useCallback, useMemo } from "react";

import { randomUUID } from "../../lib/utils";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { primaryEnvironmentIdAtom } from "../../state/primaryEnvironment";
import { environmentServerConfigsAtom, serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  type CatalogRenameResult,
  type EnvironmentSectionLayout,
  type RemovedSection,
  type SectionLayout,
  type SectionOccupancy,
  type SectionOrigin,
  type SectionRef,
  catalogWithCreatedSection,
  catalogWithRenamedSection,
  catalogWithRestoredSection,
  catalogWithoutSection,
  layoutFromGroupOrder,
  mergeListedGroupOrder,
  readThreadSections,
  sectionLayoutOrder,
  sweepEmptySections,
} from "./logic";
import { type CatalogEdit, type LiveLayout, writeCatalog } from "./catalogWrite";

/** One environment's section catalog, as its server stores it. */
export interface EnvironmentSectionCatalog extends EnvironmentSectionLayout {
  readonly environmentId: EnvironmentId;
}

// Reused while an environment's stored catalog is unchanged, so unrelated
// config updates keep every catalog's identity.
const previousCatalogs = new Map<EnvironmentId, EnvironmentSectionCatalog & { raw: unknown }>();

/**
 * Every environment whose server stores sections, primary first, then in
 * connection order. Each lists its own sections: a section belongs to the
 * environment whose catalog holds it, whichever client is looking. The
 * hosted app has no primary and still sees every environment's catalog.
 */
export const sectionCatalogsAtom = Atom.make((get): readonly EnvironmentSectionCatalog[] => {
  const configs = get(environmentServerConfigsAtom);
  const primaryEnvironmentId = get(primaryEnvironmentIdAtom);
  const catalogs: EnvironmentSectionCatalog[] = [];
  for (const environmentId of previousCatalogs.keys()) {
    if (!configs.has(environmentId)) previousCatalogs.delete(environmentId);
  }
  for (const [environmentId, config] of configs) {
    if (config.environment.capabilities.threadSections !== true) continue;
    const raw = config.settings.threadSections;
    const generalIndex = config.settings.threadSectionsGeneralIndex;
    const previous = previousCatalogs.get(environmentId);
    const catalog =
      previous !== undefined && previous.raw === raw && previous.generalIndex === generalIndex
        ? previous
        : { environmentId, sections: readThreadSections(raw), generalIndex, raw };
    previousCatalogs.set(environmentId, catalog);
    catalogs.push(catalog);
  }
  return catalogs.toSorted(
    (left, right) =>
      Number(right.environmentId === primaryEnvironmentId) -
      Number(left.environmentId === primaryEnvironmentId),
  );
}).pipe(Atom.withLabel("scient-sections-environment-catalogs"));

/** The catalog of one environment, outside React; null when its server stores no sections. */
export function readSectionCatalog(environmentId: string): EnvironmentSectionCatalog | null {
  return (
    appAtomRegistry
      .get(sectionCatalogsAtom)
      .find((catalog) => catalog.environmentId === environmentId) ?? null
  );
}

function readLiveLayout(environmentId: EnvironmentId): LiveLayout | null {
  const settings = appAtomRegistry.get(serverEnvironment.settingsValueAtom(environmentId));
  return settings === null
    ? null
    : { sections: settings.threadSections, generalIndex: settings.threadSectionsGeneralIndex };
}

// Each environment's writes run one at a time, so this client's edits never
// race each other. Edits from other clients are caught by the server-side
// precondition (see `writeCatalog`).
const writeQueues = new Map<EnvironmentId, Promise<unknown>>();

export interface ThreadSectionCatalogs {
  /** See `sectionCatalogsAtom`. */
  readonly catalogs: readonly EnvironmentSectionCatalog[];
  /** Whether any connected environment stores sections. */
  readonly available: boolean;
  readonly catalogFor: (environmentId: string) => EnvironmentSectionCatalog | null;
  /** Creates a section in one environment, or returns its existing one with that name. */
  readonly create: (
    environmentId: EnvironmentId,
    name: string,
    origin?: SectionOrigin,
  ) => Promise<ThreadSection | null>;
  readonly rename: (ref: SectionRef, name: string) => Promise<CatalogRenameResult | null>;
  /** Removes the entry; its threads join General until it is restored. */
  readonly remove: (ref: SectionRef) => Promise<RemovedSection | null>;
  readonly restore: (environmentId: EnvironmentId, removed: RemovedSection) => Promise<boolean>;
  /** Restores sections removed together, each at its old position. */
  readonly restoreAll: (
    environmentId: EnvironmentId,
    removed: readonly RemovedSection[],
  ) => Promise<boolean>;
  /** Runs one cleanup pass (see `sweepEmptySections`); resolves the sections it removed. */
  readonly sweepEmpty: (
    environmentId: EnvironmentId,
    input: {
      readonly occupancy: SectionOccupancy;
      readonly judge: boolean;
      readonly afterDays: number;
      readonly isCurrent?: () => boolean;
    },
  ) => Promise<readonly RemovedSection[]>;
  /**
   * Applies a new order of one environment's listed groups: its section ids
   * and General. Sections not listed, such as those hidden by a project scope
   * or created elsewhere meanwhile, keep their slots.
   */
  readonly reorder: (
    environmentId: EnvironmentId,
    listedGroupIds: readonly string[],
  ) => Promise<boolean>;
}

export function useThreadSectionCatalogs(): ThreadSectionCatalogs {
  const catalogs = useAtomValue(sectionCatalogsAtom);
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    reportFailure: false,
  });

  /** Applies `edit` to one environment's stored catalog (see `writeCatalog`), one write at a time. */
  const write = useCallback(
    <R>(environmentId: EnvironmentId, edit: CatalogEdit<R>) => {
      const run = async (): Promise<{ ok: boolean; result: R | null }> => {
        // A server that predates sections, or one not loaded, can't store a catalog.
        const stored = readSectionCatalog(environmentId) ? readLiveLayout(environmentId) : null;
        if (stored === null) return { ok: false, result: null };
        return writeCatalog({
          stored,
          edit,
          send: async (patch) => {
            const outcome = await updateSettings({ environmentId, input: { patch } });
            if (outcome._tag !== "Success") return null;
            return {
              sections: outcome.value.threadSections,
              generalIndex: outcome.value.threadSectionsGeneralIndex,
            };
          },
        });
      };
      const queue = writeQueues.get(environmentId) ?? Promise.resolve();
      const next = queue.then(run, run);
      writeQueues.set(environmentId, next);
      return next;
    },
    [updateSettings],
  );

  const create = useCallback(
    async (environmentId: EnvironmentId, name: string, origin?: SectionOrigin) => {
      const { ok, result } = await write(environmentId, (layout) => {
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
    async (ref: SectionRef, name: string) => {
      const { ok, result } = await write(EnvironmentId.make(ref.environmentId), (layout) => {
        const renamed = catalogWithRenamedSection(layout.sections, ref.sectionId, name);
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
    async (ref: SectionRef) => {
      const { ok, result } = await write(EnvironmentId.make(ref.environmentId), (layout) => {
        const removed = catalogWithoutSection(layout.sections, layout.generalIndex, ref.sectionId);
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
    async (environmentId: EnvironmentId, removed: RemovedSection) =>
      (
        await write(environmentId, (layout) => ({
          layout: catalogWithRestoredSection(layout.sections, removed),
          result: true,
        }))
      ).ok,
    [write],
  );

  const restoreAll = useCallback(
    async (environmentId: EnvironmentId, removed: readonly RemovedSection[]) =>
      (
        await write(environmentId, (layout) => {
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
    async (
      environmentId: EnvironmentId,
      input: {
        readonly occupancy: SectionOccupancy;
        readonly judge: boolean;
        readonly afterDays: number;
        readonly isCurrent?: () => boolean;
      },
    ) => {
      const { ok, result } = await write(environmentId, (layout) => {
        if (input.isCurrent?.() === false) return { layout: null, result: [] };
        const swept = sweepEmptySections({
          sections: layout.sections,
          generalIndex: layout.generalIndex,
          now: new Date(),
          occupancy: input.occupancy,
          judge: input.judge,
          afterDays: input.afterDays,
        });
        return { layout: swept, result: swept?.removed ?? [] };
      });
      return ok ? (result ?? []) : [];
    },
    [write],
  );

  const reorder = useCallback(
    async (environmentId: EnvironmentId, listedGroupIds: readonly string[]) =>
      // Merged against each attempt's catalog, so a retry after another
      // client's edit still leaves unlisted sections where that edit put them.
      (
        await write(environmentId, (layout) => ({
          layout: layoutFromGroupOrder(
            layout.sections,
            mergeListedGroupOrder(
              sectionLayoutOrder(layout.sections, layout.generalIndex),
              listedGroupIds,
            ),
          ),
          result: true,
        }))
      ).ok,
    [write],
  );

  const catalogFor = useCallback(
    (environmentId: string) =>
      catalogs.find((catalog) => catalog.environmentId === environmentId) ?? null,
    [catalogs],
  );

  return useMemo(
    () => ({
      catalogs,
      available: catalogs.length > 0,
      catalogFor,
      create,
      rename,
      remove,
      restore,
      restoreAll,
      sweepEmpty,
      reorder,
    }),
    [catalogFor, catalogs, create, remove, rename, reorder, restore, restoreAll, sweepEmpty],
  );
}
