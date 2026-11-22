import { T, useGT, useMessages } from "gt-react";
import { CustomMathActionDialog } from "./CustomMathActionDialog";
import type { CustomMathCommand } from "./customMath";
import { ShortcutReference } from "./ShortcutReference";
import { Fragment, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ChevronDownIcon, EllipsisIcon, PlusIcon } from "lucide-react";
import type { ResolvedKeybindingsConfig } from "@t3tools/contracts";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { Badge } from "~/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Switch } from "~/components/ui/switch";
import { SettingsRow } from "~/components/settings/settingsLayout";
import {
  ShortcutKeys,
  SHORTCUT_PILL_BUTTON_CLASS,
  SHORTCUT_ROW_CLASS,
} from "~/components/settings/ShortcutRow";
import { type KeyboardScope } from "./catalog";
import { eventStroke, isMacKeyboard, labelKeys } from "./keys";
import {
  DEFAULT_KEYBOARD_PREFERENCES,
  effectiveSurfaceBindings,
  authoringCommands,
  getKeyboardPreferences,
  importKeyboardPreferences,
  saveKeyboardPreferences,
  subscribeKeyboardPreferences,
  type KeyboardPreferences,
  type KeyboardPreferencesSnapshot,
} from "./preferences";
import { appKeysEqual, conditionsOverlap } from "./conflicts";
import {
  shortcutToKeybindingInput,
  whenAstToExpression,
} from "~/components/settings/KeybindingsSettings.logic";

const NO_APP_BINDINGS: ResolvedKeybindingsConfig = [];
const MATH_OPTION_ROW_CLASS = `${SHORTCUT_ROW_CLASS} py-2`;
export function AuthoringKeybindingsSettings({
  scope,
  query = "",
  appBindings = NO_APP_BINDINGS,
}: {
  readonly scope: KeyboardScope | "writing";
  readonly query?: string;
  readonly appBindings?: ResolvedKeybindingsConfig;
}) {
  const gt = useGT();
  const messages = useMessages();
  const snapshot = useSyncExternalStore(
    subscribeKeyboardPreferences,
    getKeyboardPreferences,
    getKeyboardPreferences,
  );
  const mac = isMacKeyboard();
  const commands = authoringCommands(snapshot.preferences, mac);
  const [customAction, setCustomAction] = useState<CustomMathCommand | null | undefined>(undefined);
  const [editing, setEditing] = useState<{
    id: string;
    index: number;
    draft: string;
    original: string;
    captured: boolean;
    snapshot: KeyboardPreferencesSnapshot;
  } | null>(null);
  const importInput = useRef<HTMLInputElement>(null);
  const editingControl = useRef<HTMLDivElement>(null);
  const [error, setError] = useState("");
  const [restoreOpen, setRestoreOpen] = useState(false);
  const [mathOptionsCard, setMathOptionsCard] = useState<HTMLDivElement | null>(null);
  const isEditing = editing !== null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- listens for pointerdown outside the editing control on the document while a keybinding is being edited
  useEffect(() => {
    if (!isEditing) return;
    const cancelOutside = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node) || editingControl.current?.contains(target)) return;
      if (target instanceof Element && target.closest("[data-authoring-keybinding-menu]")) return;
      setEditing(null);
      setError("");
    };
    document.addEventListener("pointerdown", cancelOutside, true);
    return () => document.removeEventListener("pointerdown", cancelOutside, true);
  }, [isEditing]);
  const effective = effectiveSurfaceBindings(snapshot.preferences, mac);
  const keysByCommand = (() => {
    const grouped = new Map<string, string[]>();
    for (const binding of effective) {
      const keys = grouped.get(binding.command) ?? [];
      keys.push(binding.keys);
      grouped.set(binding.command, keys);
    }
    return grouped;
  })();
  const visible = commands.filter(
    (command) =>
      (command.scope === scope ||
        (scope === "writing" && ["latex", "math", "table"].includes(command.scope))) &&
      (
        command.id +
        " " +
        command.label +
        " " +
        messages(command.label) +
        " " +
        (keysByCommand.get(command.id)?.join(" ") ?? "")
      )
        .toLowerCase()
        .includes(query.toLowerCase().replace(/^\\/u, "")),
  );
  const save = (preferences: KeyboardPreferences, expected = snapshot) => {
    try {
      saveKeyboardPreferences(preferences, expected);
      setError("");
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : gt("Shortcuts were not saved."));
      return false;
    }
  };
  const update = (patch: Partial<KeyboardPreferences>) =>
    save({ ...snapshot.preferences, ...patch });
  const resetCommand = (id: string) => {
    const overrides = { ...snapshot.preferences.overrides };
    delete overrides[id];
    update({ overrides });
  };
  const editingKeys = editing?.captured && editing.draft.trim() ? [editing.draft.trim()] : [];
  const appOverlaps = appBindings
    .filter(
      (binding) =>
        editingKeys.some((keys) =>
          appKeysEqual(keys.split(" ")[0]!, shortcutToKeybindingInput(binding.shortcut), mac),
        ) && conditionsOverlap(whenAstToExpression(binding.whenAst), "!terminalFocus"),
    )
    .map((binding) => binding.command);
  const beginEditing = (id: string, index: number, draft: string) => {
    setEditing({ id, index, draft, original: draft, captured: false, snapshot });
    setError("");
  };
  const saveEditing = (keys: readonly string[]) => {
    if (!editing?.draft.trim()) return;
    const next = [...keys];
    next.splice(editing.index, editing.index < keys.length ? 1 : 0, editing.draft.trim());
    if (
      save(
        {
          ...editing.snapshot.preferences,
          overrides: { ...editing.snapshot.preferences.overrides, [editing.id]: next },
        },
        editing.snapshot,
      )
    ) {
      setEditing(null);
    }
  };
  const removeEditing = (keys: readonly string[]) => {
    if (!editing || editing.index >= keys.length) return;
    const next = keys.filter((_, index) => index !== editing.index);
    if (
      save(
        {
          ...editing.snapshot.preferences,
          overrides: { ...editing.snapshot.preferences.overrides, [editing.id]: next },
        },
        editing.snapshot,
      )
    ) {
      setEditing(null);
    }
  };
  const captureInput = (
    id: string,
    label: string,
    index: number,
    activeEdit: NonNullable<typeof editing>,
  ) => (
    <Input
      data-keybinding-capture=""
      autoFocus
      readOnly
      aria-label={gt("Shortcut for {command}", { command: label })}
      title={gt("Press successive keys for a sequence; Escape cancels")}
      value={activeEdit.captured ? activeEdit.draft : ""}
      placeholder={gt("Press shortcut")}
      font="mono"
      size="sm"
      className="w-44"
      onKeyDown={(event) => {
        if (event.key === "Tab") return;
        event.preventDefault();
        event.stopPropagation();
        if (event.key === "Escape") {
          setEditing(null);
          setError("");
          return;
        }
        if (event.repeat) return;
        const stroke = eventStroke(event.nativeEvent, true);
        if (!stroke) return;
        const portable = stroke.replace(mac ? /^meta\+/u : /^ctrl\+/u, "mod+");
        setEditing((current) =>
          current?.id === id && current.index === index
            ? {
                ...current,
                draft: current.captured ? current.draft + " " + portable : portable,
                captured: true,
              }
            : current,
        );
      }}
    />
  );
  return (
    <div data-authoring-scope={scope}>
      <div className="flex flex-wrap items-center justify-between gap-1 px-3 py-2 sm:px-4">
        {scope === "math" ? (
          <Popover>
            <PopoverTrigger render={<Button size="xs" variant="ghost-muted" className="group" />}>
              <T>Math input behavior and preset</T>
              <ChevronDownIcon className="size-3.5 transition-transform group-aria-expanded:rotate-180" />
            </PopoverTrigger>
            <PopoverPopup
              ref={setMathOptionsCard}
              align="start"
              aria-label={gt("Math input behavior and preset")}
              className="w-[34rem] max-w-[calc(100vw-2rem)]"
              padding="none"
              side="bottom"
            >
              <div className="p-2">
                <div id="math-input-behavior" className="grid gap-x-3 sm:grid-cols-2">
                  <div>
                    <SettingsRow
                      className={MATH_OPTION_ROW_CLASS}
                      title={gt("Math preset")}
                      control={
                        <Select
                          value={snapshot.preferences.mathPreset}
                          onValueChange={(value) =>
                            update({ mathPreset: value as KeyboardPreferences["mathPreset"] })
                          }
                        >
                          <SelectTrigger
                            size="sm"
                            className="w-44 max-w-full"
                            aria-label={gt("Math shortcut preset")}
                          >
                            <SelectValue>
                              {snapshot.preferences.mathPreset === "lyx"
                                ? "LyX"
                                : gt("Minimal", { $context: "math shortcut preset" })}
                            </SelectValue>
                          </SelectTrigger>
                          <SelectContent
                            align="start"
                            alignItemWithTrigger={false}
                            collisionBoundary={mathOptionsCard ?? undefined}
                            className="max-w-(--available-width)"
                          >
                            <SelectItem value="lyx">
                              <T>Supported LyX-style sequences</T>
                            </SelectItem>
                            <SelectItem value="minimal">
                              <T>Minimal: palette and equation insertion</T>
                            </SelectItem>
                          </SelectContent>
                        </Select>
                      }
                    />
                    <SettingsRow
                      className={MATH_OPTION_ROW_CLASS}
                      title={gt("Command completion")}
                      control={
                        <Select
                          value={snapshot.preferences.completion}
                          onValueChange={(value) =>
                            update({ completion: value as KeyboardPreferences["completion"] })
                          }
                        >
                          <SelectTrigger
                            size="sm"
                            className="w-full sm:w-40"
                            aria-label={gt("Math command completion")}
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent
                            align="start"
                            alignItemWithTrigger={false}
                            collisionBoundary={mathOptionsCard ?? undefined}
                            className="max-w-(--available-width)"
                          >
                            <SelectItem value="space-tab">
                              <T>Space and Tab</T>
                            </SelectItem>
                            <SelectItem value="tab">
                              <T>Tab only</T>
                            </SelectItem>
                            <SelectItem value="off">
                              <T context="command completion is off">Off</T>
                            </SelectItem>
                          </SelectContent>
                        </Select>
                      }
                    />
                  </div>
                  <div className="border-t border-border/40 sm:border-t-0 sm:border-l sm:pl-3">
                    <SettingsRow
                      className={MATH_OPTION_ROW_CLASS}
                      title={gt("Shift+Enter adds a matrix row")}
                      control={
                        <Switch
                          aria-label={gt("Shift+Enter adds a matrix row")}
                          checked={snapshot.preferences.matrixEnter}
                          onCheckedChange={(checked) => update({ matrixEnter: checked })}
                        />
                      }
                    />
                  </div>
                  <div className="border-t border-border/40 sm:col-span-2">
                    <SettingsRow
                      className={MATH_OPTION_ROW_CLASS}
                      title={gt("Sequence timeout")}
                      description={gt(
                        "Applies to Write, Tables, Markdown, Math, and PDF shortcuts.",
                      )}
                      control={
                        <Select
                          value={String(snapshot.preferences.sequenceTimeoutMs)}
                          onValueChange={(value) => update({ sequenceTimeoutMs: Number(value) })}
                        >
                          <SelectTrigger
                            size="sm"
                            className="w-full sm:w-32"
                            aria-label={gt("Shortcut sequence timeout")}
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent
                            alignItemWithTrigger={false}
                            collisionBoundary={mathOptionsCard ?? undefined}
                            className="max-w-(--available-width)"
                          >
                            {[
                              ...new Set([
                                1000,
                                2500,
                                5000,
                                10000,
                                snapshot.preferences.sequenceTimeoutMs,
                              ]),
                            ]
                              .sort((a, b) => a - b)
                              .map((ms) => (
                                <SelectItem key={ms} value={String(ms)}>
                                  {gt("{seconds} seconds", { seconds: ms / 1000 })}
                                </SelectItem>
                              ))}
                          </SelectContent>
                        </Select>
                      }
                    />
                  </div>
                </div>
              </div>
            </PopoverPopup>
          </Popover>
        ) : (
          <span />
        )}
        <div
          className="flex flex-wrap items-center justify-end gap-1"
          role="group"
          aria-label={gt("Document shortcut profile")}
        >
          <input
            ref={importInput}
            hidden
            aria-label={gt("Import document shortcuts file")}
            type="file"
            accept=".json,application/json"
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = "";
              if (!file) return;
              const expected = snapshot;
              if (file.size > 1000000) {
                setError(gt("Shortcut file is too large."));
                return;
              }
              void file
                .text()
                .then((text) => {
                  const imported = importKeyboardPreferences(text);
                  if (
                    window.confirm(
                      gt(
                        "Replace Write, Tables, Markdown, Math, and PDF shortcuts, custom math actions, and math behavior with this file? Application keybindings will not change.",
                      ),
                    )
                  )
                    save(imported, expected);
                })
                .catch((cause) =>
                  setError(cause instanceof Error ? cause.message : gt("Import failed.")),
                );
            }}
          />
          {scope === "math" || scope === "writing" ? (
            <Button size="xs" variant="ghost-muted" onClick={() => setCustomAction(null)}>
              <T>New math action</T>
            </Button>
          ) : null}
          <ShortcutReference appBindings={appBindings} />
          <Button size="xs" variant="ghost-muted" onClick={() => importInput.current?.click()}>
            <T context="verb, imports a shortcuts file">Import</T>
          </Button>
          <Button
            size="xs"
            variant="ghost-muted"
            onClick={() => {
              const url = URL.createObjectURL(
                new Blob([JSON.stringify(snapshot.preferences, null, 2)], {
                  type: "application/json",
                }),
              );
              const link = document.createElement("a");
              link.href = url;
              link.download = "scient-authoring-shortcuts.json";
              link.click();
              setTimeout(() => URL.revokeObjectURL(url), 0);
            }}
          >
            <T context="verb, exports the shortcuts">Export</T>
          </Button>
          <Popover open={restoreOpen} onOpenChange={setRestoreOpen}>
            <PopoverTrigger render={<Button size="xs" variant="ghost-muted" />}>
              <T>Restore defaults</T>
            </PopoverTrigger>
            <PopoverPopup
              align="end"
              aria-label={gt("Restore document shortcut defaults")}
              className="w-80 max-w-[calc(100vw-2rem)]"
              side="bottom"
            >
              <div className="space-y-3">
                <div className="space-y-1">
                  <p className="text-sm font-medium">
                    <T>Restore defaults?</T>
                  </p>
                  <p className="text-xs text-muted-foreground">
                    <T>
                      Reset Write, Tables, Markdown, Math, and PDF shortcuts and Math input
                      settings, and remove custom math actions. General shortcuts stay unchanged.
                    </T>
                  </p>
                </div>
                <div className="flex justify-end gap-1">
                  <Button size="xs" variant="ghost-muted" onClick={() => setRestoreOpen(false)}>
                    <T>Cancel</T>
                  </Button>
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() => {
                      if (save(DEFAULT_KEYBOARD_PREFERENCES)) setRestoreOpen(false);
                    }}
                  >
                    <T context="verb, restores the defaults">Restore</T>
                  </Button>
                </div>
              </div>
            </PopoverPopup>
          </Popover>
        </div>
      </div>
      {customAction !== undefined ? (
        <CustomMathActionDialog action={customAction} onClose={() => setCustomAction(undefined)} />
      ) : null}
      {snapshot.migrated ? (
        <p role="status" className="px-3 py-1 text-xs text-muted-foreground sm:px-4">
          <T>
            Legacy math shortcuts loaded. Your next save writes the shared format and keeps the
            original data.
          </T>
        </p>
      ) : null}
      {snapshot.error || error ? (
        <p role="alert" className="px-3 py-1 text-xs text-destructive sm:px-4">
          {error || snapshot.error}
        </p>
      ) : null}
      <div>
        {visible.map((command) => {
          const keys = keysByCommand.get(command.id) ?? [];
          const custom = snapshot.preferences.customMath?.find((entry) => entry.id === command.id);
          const customized = Object.hasOwn(snapshot.preferences.overrides, command.id);
          const disabled = customized && keys.length === 0;
          const activeEdit = editing?.id === command.id ? editing : null;
          const seenKeys = new Map<string, number>();
          const keyEntries = keys.map((key, index) => {
            const occurrence = seenKeys.get(key) ?? 0;
            seenKeys.set(key, occurrence + 1);
            return { key, index, identity: key + "-" + occurrence };
          });
          const hasOverlap = activeEdit?.captured && appOverlaps.length > 0;
          const reserved =
            activeEdit?.captured && /(?:mod|meta)\+m(?: |$)|ctrl\+space/u.test(activeEdit.draft);
          return (
            <SettingsRow
              key={command.id}
              className={SHORTCUT_ROW_CLASS}
              title={
                <span className="flex items-center gap-2">
                  {messages(command.label)}
                  {scope === "writing" ? (
                    <span className="text-xs text-muted-foreground">
                      {command.scope === "latex"
                        ? gt("Write", { $context: "shortcut section for writing documents" })
                        : command.scope === "table"
                          ? gt("Table", { $context: "shortcut section for tables" })
                          : gt("Math")}
                    </span>
                  ) : null}
                  {customized ? (
                    <Badge variant="outline" size="sm">
                      {disabled
                        ? gt("Disabled", { $context: "shortcut is turned off" })
                        : gt("Custom", { $context: "shortcut was changed from the default" })}
                    </Badge>
                  ) : null}
                </span>
              }
              description={
                hasOverlap || reserved ? (
                  <span role="status">
                    {hasOverlap
                      ? `${gt("Also used by an application command; this shortcut takes priority only in its focused document.")} `
                      : ""}
                    {reserved
                      ? gt("This shortcut may be reserved by the operating system or input method.")
                      : ""}
                  </span>
                ) : undefined
              }
              control={
                <div
                  ref={activeEdit ? editingControl : undefined}
                  className="flex flex-wrap items-center justify-end gap-1.5"
                >
                  {activeEdit?.captured && activeEdit.draft.trim() !== activeEdit.original ? (
                    <Button size="sm" onClick={() => saveEditing(keys)}>
                      <T context="saves the shortcut">Save</T>
                    </Button>
                  ) : null}
                  {keys.length > 0 || customized || custom ? (
                    <Menu>
                      <MenuTrigger
                        render={
                          <Button
                            size="icon-sm"
                            variant="ghost-muted-row"
                            aria-label={gt("Actions for {command}", {
                              command: messages(command.label),
                            })}
                          />
                        }
                      >
                        <EllipsisIcon className="size-3.5" />
                      </MenuTrigger>
                      <MenuPopup
                        align="end"
                        data-authoring-keybinding-menu={activeEdit ? "" : undefined}
                      >
                        {custom ? (
                          <>
                            <MenuItem onClick={() => setCustomAction(custom)}>
                              <T>Edit expression</T>
                            </MenuItem>
                            <MenuItem
                              onClick={() => {
                                const overrides = { ...snapshot.preferences.overrides };
                                delete overrides[custom.id];
                                update({
                                  customMath: snapshot.preferences.customMath!.filter(
                                    (entry) => entry.id !== custom.id,
                                  ),
                                  overrides,
                                });
                              }}
                            >
                              <T>Delete math action</T>
                            </MenuItem>
                          </>
                        ) : null}
                        {activeEdit && activeEdit.index < keys.length ? (
                          <MenuItem onClick={() => removeEditing(keys)}>
                            <T>Remove shortcut</T>
                          </MenuItem>
                        ) : null}
                        {keys.length > 0 ? (
                          <MenuItem
                            onClick={() =>
                              update({
                                overrides: {
                                  ...snapshot.preferences.overrides,
                                  [command.id]: [],
                                },
                              })
                            }
                          >
                            <T context="turn the shortcut off">Disable</T>
                          </MenuItem>
                        ) : null}
                        {customized ? (
                          <MenuItem onClick={() => resetCommand(command.id)}>
                            <T>Reset to default</T>
                          </MenuItem>
                        ) : null}
                      </MenuPopup>
                    </Menu>
                  ) : null}
                  {keys.length > 0 ? (
                    activeEdit?.index === keys.length ? (
                      captureInput(command.id, messages(command.label), keys.length, activeEdit)
                    ) : (
                      <Button
                        size="icon-xs"
                        variant="ghost-muted-row"
                        aria-label={gt("Add shortcut for {command}", {
                          command: messages(command.label),
                        })}
                        onClick={() => beginEditing(command.id, keys.length, "")}
                      >
                        <PlusIcon />
                      </Button>
                    )
                  ) : null}
                  {keyEntries.map(({ key, index, identity }) =>
                    activeEdit?.index === index ? (
                      <Fragment key={identity}>
                        {captureInput(command.id, messages(command.label), index, activeEdit)}
                      </Fragment>
                    ) : (
                      <button
                        key={identity}
                        type="button"
                        className={SHORTCUT_PILL_BUTTON_CLASS}
                        aria-label={gt("Edit {command}: {keys}", {
                          command: command.id,
                          keys: labelKeys(key, mac),
                        })}
                        onClick={() => beginEditing(command.id, index, key)}
                      >
                        <ShortcutKeys value={key} />
                      </button>
                    ),
                  )}
                  {keys.length === 0 ? (
                    activeEdit ? (
                      captureInput(command.id, messages(command.label), 0, activeEdit)
                    ) : (
                      <Button
                        size="xs"
                        variant="ghost-muted"
                        aria-label={gt("Edit {command}", { command: command.id })}
                        onClick={() => beginEditing(command.id, 0, "")}
                      >
                        {disabled
                          ? gt("Disabled", { $context: "shortcut is turned off" })
                          : gt("Assign shortcut")}
                      </Button>
                    )
                  ) : null}
                </div>
              }
            />
          );
        })}
        {visible.length === 0 ? (
          <p className="px-4 py-12 text-center text-sm text-muted-foreground">
            <T>No matching document commands.</T>
          </p>
        ) : null}
      </div>
    </div>
  );
}
