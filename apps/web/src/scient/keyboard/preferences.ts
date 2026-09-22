import { surfaceCommands, scopesOverlap, type KeyboardScope } from "./catalog";
import {
  isMacKeyboard,
  keysOverlap,
  normalizeKeys,
  reservedEditingKeys,
  validateKeys,
} from "./keys";

export const KEYBOARD_PREFERENCES_KEY = "scient.authoringKeyboard.v1";
const LEGACY_KEY = "scient.mathInputBindings.v1";
export interface KeyboardPreferences {
  readonly version: 1;
  readonly overrides: Readonly<Record<string, readonly string[]>>;
  readonly mathPreset: "lyx" | "minimal";
  readonly completion: "space-tab" | "tab" | "off";
  readonly automaticOperators: boolean;
  readonly matrixEnter: boolean;
  readonly sequenceTimeoutMs: number;
}
export interface KeyboardPreferencesSnapshot {
  readonly preferences: KeyboardPreferences;
  readonly error: string;
  readonly migrated: boolean;
}
export const DEFAULT_KEYBOARD_PREFERENCES: KeyboardPreferences = {
  version: 1,
  overrides: {},
  mathPreset: "lyx",
  completion: "space-tab",
  automaticOperators: true,
  matrixEnter: true,
  sequenceTimeoutMs: 2500,
};
let current: KeyboardPreferencesSnapshot | undefined;
let persisted: string | null = null;
const listeners = new Set<() => void>();
const cache = new Map<
  boolean,
  { snapshot: KeyboardPreferencesSnapshot; bindings: readonly SurfaceBinding[] }
>();
export interface SurfaceBinding {
  readonly command: string;
  readonly keys: string;
  readonly scope: KeyboardScope;
}
export function effectiveSurfaceBindings(
  preferences: KeyboardPreferences,
  mac: boolean,
): readonly SurfaceBinding[] {
  return surfaceCommands(mac).flatMap((command) => {
    const defaults =
      preferences.mathPreset === "minimal" &&
      command.scope === "math" &&
      !["math.inline", "math.display", "math.palette"].includes(command.id)
        ? []
        : command.defaultKeys;
    return (preferences.overrides[command.id] ?? defaults).map((keys) => ({
      command: command.id,
      scope: command.scope,
      keys,
    }));
  });
}
export function validateKeyboardPreferences(
  value: unknown,
  mac = isMacKeyboard(),
): KeyboardPreferences {
  if (!value || typeof value !== "object")
    throw new Error("Expected a keyboard preferences object.");
  const v = value as KeyboardPreferences;
  if (
    v.version !== 1 ||
    !v.overrides ||
    typeof v.overrides !== "object" ||
    Array.isArray(v.overrides) ||
    !["lyx", "minimal"].includes(v.mathPreset) ||
    !["space-tab", "tab", "off"].includes(v.completion) ||
    typeof v.automaticOperators !== "boolean" ||
    typeof v.matrixEnter !== "boolean" ||
    !Number.isInteger(v.sequenceTimeoutMs) ||
    v.sequenceTimeoutMs < 500 ||
    v.sequenceTimeoutMs > 10000
  )
    throw new Error("Invalid keyboard preferences. Sequence timeout must be 500–10000 ms.");
  const commands = new Set(surfaceCommands(mac).map((command) => command.id));
  let count = 0;
  const overrides: Record<string, readonly string[]> = {};
  for (const [command, keys] of Object.entries(v.overrides)) {
    if (!commands.has(command)) throw new Error("Unknown authoring command: " + command);
    if (!Array.isArray(keys) || keys.length > 30)
      throw new Error("Use an array of shortcuts; an empty array disables a command.");
    overrides[command] = keys.map((key) => {
      if (typeof key !== "string") throw new Error("Shortcut keys must be text.");
      validateKeys(key);
      if (reservedEditingKeys(key, mac))
        throw new Error(
          "This shortcut is reserved for native editing, clipboard, save, or undo. Choose another shortcut.",
        );
      if (++count > 500) throw new Error("At most 500 custom shortcuts are supported.");
      return key.trim().toLowerCase();
    });
  }
  const preferences: KeyboardPreferences = {
    version: 1,
    overrides,
    mathPreset: v.mathPreset,
    completion: v.completion,
    automaticOperators: v.automaticOperators,
    matrixEnter: v.matrixEnter,
    sequenceTimeoutMs: v.sequenceTimeoutMs,
  };
  const bindings = effectiveSurfaceBindings(preferences, mac);
  for (let i = 0; i < bindings.length; i++)
    for (let j = i + 1; j < bindings.length; j++) {
      const a = bindings[i]!,
        b = bindings[j]!;
      if (!scopesOverlap(a.scope, b.scope) || !keysOverlap(a.keys, b.keys, mac)) continue;
      // Default aliases occasionally normalize identically. A sequence prefix is never safe.
      if (a.command === b.command && normalizeKeys(a.keys, mac) === normalizeKeys(b.keys, mac))
        continue;
      throw new Error(
        `Shortcut conflict: ${a.keys} (${a.command}) overlaps ${b.keys} (${b.command}). Disable or rebind one first.`,
      );
    }
  return preferences;
}
/** Legacy imports preserve alternatives and exact-key overrides, never delete the old key. */
export function importKeyboardPreferences(
  text: string,
  mac = isMacKeyboard(),
): KeyboardPreferences {
  if (text.length > 100000) throw new Error("Shortcut file is too large.");
  const value: unknown = JSON.parse(text);
  if (!Array.isArray(value)) return validateKeyboardPreferences(value, mac);
  if (value.length > 500) throw new Error("Too many legacy math bindings.");
  const commands = surfaceCommands(mac);
  const overrides: Record<string, string[]> = {};
  for (const entry of value) {
    if (
      !entry ||
      typeof entry.keys !== "string" ||
      typeof entry.command !== "string" ||
      !commands.some((command) => command.id === entry.command && command.scope === "math")
    )
      throw new Error("Invalid legacy math shortcut.");
    validateKeys(entry.keys);
    for (const command of commands.filter((command) => command.scope === "math")) {
      const existing = overrides[command.id] ?? [...command.defaultKeys];
      const remaining = existing.filter(
        (keys) => normalizeKeys(keys, mac) !== normalizeKeys(entry.keys, mac),
      );
      if (remaining.length !== existing.length) overrides[command.id] = remaining;
    }
    overrides[entry.command] = [
      ...(overrides[entry.command] ??
        commands.find((command) => command.id === entry.command)!.defaultKeys),
      entry.keys,
    ];
  }
  return validateKeyboardPreferences({ ...DEFAULT_KEYBOARD_PREFERENCES, overrides }, mac);
}
function readPreferences(): KeyboardPreferencesSnapshot {
  try {
    persisted = localStorage.getItem(KEYBOARD_PREFERENCES_KEY);
    const legacy = persisted === null ? localStorage.getItem(LEGACY_KEY) : null;
    return {
      preferences:
        persisted !== null
          ? importKeyboardPreferences(persisted)
          : legacy !== null
            ? importKeyboardPreferences(legacy)
            : DEFAULT_KEYBOARD_PREFERENCES,
      error: "",
      migrated: persisted === null && legacy !== null,
    };
  } catch (error) {
    return {
      preferences: DEFAULT_KEYBOARD_PREFERENCES,
      error: error instanceof Error ? error.message : "Keyboard preferences could not be read.",
      migrated: false,
    };
  }
}
export function reloadKeyboardPreferences() {
  current = readPreferences();
  cache.clear();
  listeners.forEach((listener) => listener());
}
export function getKeyboardPreferences(): KeyboardPreferencesSnapshot {
  return (current ??= readPreferences());
}
export function subscribeKeyboardPreferences(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1 && typeof window !== "undefined")
    window.addEventListener("storage", storageChanged);
  return () => {
    listeners.delete(listener);
    if (!listeners.size && typeof window !== "undefined")
      window.removeEventListener("storage", storageChanged);
  };
}
function storageChanged(event: StorageEvent) {
  if (event.key === null || event.key === KEYBOARD_PREFERENCES_KEY || event.key === LEGACY_KEY)
    reloadKeyboardPreferences();
}
export function saveKeyboardPreferences(
  preferences: KeyboardPreferences,
  expected = getKeyboardPreferences(),
) {
  const validated = validateKeyboardPreferences(preferences);
  if (
    expected !== getKeyboardPreferences() ||
    localStorage.getItem(KEYBOARD_PREFERENCES_KEY) !== persisted
  ) {
    reloadKeyboardPreferences();
    throw new Error("Shortcuts changed elsewhere. Review the latest values before saving.");
  }
  localStorage.setItem(KEYBOARD_PREFERENCES_KEY, JSON.stringify(validated));
  reloadKeyboardPreferences();
}
export function surfaceBindings(
  scope?: KeyboardScope,
  mac = isMacKeyboard(),
): readonly SurfaceBinding[] {
  const snapshot = getKeyboardPreferences();
  let entry = cache.get(mac);
  if (entry?.snapshot !== snapshot) {
    entry = { snapshot, bindings: effectiveSurfaceBindings(snapshot.preferences, mac) };
    cache.set(mac, entry);
  }
  return scope ? entry.bindings.filter((binding) => binding.scope === scope) : entry.bindings;
}
export function commandKeys(command: string, mac = isMacKeyboard()): readonly string[] {
  return surfaceBindings(undefined, mac)
    .filter((binding) => binding.command === command)
    .map((binding) => binding.keys);
}
