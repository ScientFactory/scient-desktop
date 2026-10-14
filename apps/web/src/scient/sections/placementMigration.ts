import { GENERAL_SECTION_GROUP_ID, sectionGroupId } from "./logic";

const PREFIX = "scient:sidebar:placement-order:";

/**
 * Carries automatic placement saved before section group ids named their
 * environment over to `scope`. It was saved per primary environment,
 * `placement-order:<environment id>`, with bare section ids; that environment
 * held the catalog, so each id becomes its group id there. Runs only while
 * `scope` has nothing saved and exactly one such entry exists; anything
 * ambiguous is left to reseed from the current manual order.
 */
export function migrateLegacyPlacement(readStorage: () => Storage, scope: string): void {
  try {
    // Reading `localStorage` itself can throw where storage is blocked.
    const storage = readStorage();
    const target = `${PREFIX}${scope}`;
    if (storage.getItem(target) !== null) return;
    const legacy = Array.from({ length: storage.length }, (_, index) => storage.key(index)).filter(
      (key): key is string =>
        key !== null && key.startsWith(PREFIX) && key !== target && key !== `${PREFIX}unavailable`,
    );
    if (legacy.length !== 1) return;
    const [key] = legacy as [string];
    const environmentId = key.slice(PREFIX.length);
    const saved: unknown = JSON.parse(storage.getItem(key) ?? "null");
    if (typeof saved !== "object" || saved === null || !("groups" in saved)) return;
    if (!Array.isArray(saved.groups)) return;
    const groups = saved.groups.map((group: unknown) =>
      typeof group === "object" &&
      group !== null &&
      "id" in group &&
      typeof group.id === "string" &&
      group.id !== GENERAL_SECTION_GROUP_ID
        ? { ...group, id: sectionGroupId({ environmentId, sectionId: group.id }) }
        : group,
    );
    storage.setItem(target, JSON.stringify({ groups }));
    storage.removeItem(key);
  } catch {
    // Placement reseeds from the current manual order without it.
  }
}
