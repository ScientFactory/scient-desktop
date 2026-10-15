import { beforeEach, expect, it } from "vitest";

import { GENERAL_SECTION_GROUP_ID, sectionGroupId } from "./logic";
import { migrateLegacyPlacement } from "./placementMigration";

/** A Map-backed `Storage`, since the unit project has no DOM storage. */
function memoryStorage(entries: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(entries));
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key) => map.get(key) ?? null,
    key: (index) => [...map.keys()][index] ?? null,
    removeItem: (key) => void map.delete(key),
    setItem: (key, value) => void map.set(key, value),
  };
}

const NEW_KEY = "scient:sidebar:placement-order:sections";
const OLD_KEY = "scient:sidebar:placement-order:laptop";
const group = (id: string) => ({ id, rows: [], order: ["laptop:t1"], upper: ["laptop:t1"] });
let storage: Storage;

beforeEach(() => {
  storage = memoryStorage({
    [OLD_KEY]: JSON.stringify({ groups: [group("research"), group(GENERAL_SECTION_GROUP_ID)] }),
  });
});

it("qualifies the saved groups with the environment they were saved for", () => {
  migrateLegacyPlacement(() => storage, "sections");
  expect(JSON.parse(storage.getItem(NEW_KEY)!)).toEqual({
    groups: [
      group(sectionGroupId({ environmentId: "laptop", sectionId: "research" })),
      group(GENERAL_SECTION_GROUP_ID),
    ],
  });
  expect(storage.getItem(OLD_KEY)).toBeNull();
});

it("never overwrites placement already saved under the new key", () => {
  storage.setItem(NEW_KEY, '{"groups":[]}');
  migrateLegacyPlacement(() => storage, "sections");
  expect(storage.getItem(NEW_KEY)).toBe('{"groups":[]}');
  expect(storage.getItem(OLD_KEY)).not.toBeNull();
});

it("leaves ambiguous or unusable entries to reseed", () => {
  storage.setItem("scient:sidebar:placement-order:desktop", '{"groups":[]}');
  migrateLegacyPlacement(() => storage, "sections");
  expect(storage.getItem(NEW_KEY)).toBeNull();

  const unavailable = memoryStorage({
    "scient:sidebar:placement-order:unavailable": '{"groups":[]}',
  });
  migrateLegacyPlacement(() => unavailable, "sections");
  expect(unavailable.getItem(NEW_KEY)).toBeNull();

  const corrupt = memoryStorage({ [OLD_KEY]: "{not json" });
  migrateLegacyPlacement(() => corrupt, "sections");
  expect(corrupt.getItem(NEW_KEY)).toBeNull();
});

it("does nothing where storage is blocked", () => {
  expect(() =>
    migrateLegacyPlacement(() => {
      throw new Error("SecurityError");
    }, "sections"),
  ).not.toThrow();
});
