import { useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { ResolvedKeybindingsConfig } from "@t3tools/contracts";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { surfaceCommands } from "./catalog";
import { eventStroke, isMacKeyboard, labelKeys } from "./keys";
import {
  DEFAULT_KEYBOARD_PREFERENCES,
  effectiveSurfaceBindings,
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
export function AuthoringKeybindingsSettings({
  query = "",
  appBindings = NO_APP_BINDINGS,
}: {
  readonly query?: string;
  readonly appBindings?: ResolvedKeybindingsConfig;
}) {
  const snapshot = useSyncExternalStore(
    subscribeKeyboardPreferences,
    getKeyboardPreferences,
    getKeyboardPreferences,
  );
  const mac = isMacKeyboard();
  const commands = useMemo(() => surfaceCommands(mac), [mac]);
  const [category, setCategory] = useState("all");
  const [editing, setEditing] = useState<{
    id: string;
    draft: string;
    snapshot: KeyboardPreferencesSnapshot;
  } | null>(null);
  const [recording, setRecording] = useState(false);
  const recorderInput = useRef<HTMLInputElement>(null);
  const [error, setError] = useState("");
  const [importDraft, setImportDraft] = useState<{
    text: string;
    snapshot: KeyboardPreferencesSnapshot;
  } | null>(null);
  const effective = effectiveSurfaceBindings(snapshot.preferences, mac);
  const visible = commands.filter(
    (command) =>
      (category === "all" || command.scope === category) &&
      (
        command.id +
        " " +
        command.label +
        " " +
        effective
          .filter((binding) => binding.command === command.id)
          .map((binding) => binding.keys)
          .join(" ")
      )
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  const save = (preferences: KeyboardPreferences, expected = snapshot) => {
    try {
      saveKeyboardPreferences(preferences, expected);
      setError("");
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Shortcuts were not saved.");
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
  const editingKeys =
    editing?.draft
      .split(",")
      .map((key) => key.trim())
      .filter(Boolean) ?? [];
  const appOverlaps = appBindings
    .filter(
      (binding) =>
        editingKeys.some((keys) =>
          appKeysEqual(keys.split(" ")[0]!, shortcutToKeybindingInput(binding.shortcut), mac),
        ) && conditionsOverlap(whenAstToExpression(binding.whenAst), "!terminalFocus"),
    )
    .map((binding) => binding.command);
  return (
    <section
      id="authoring"
      aria-labelledby="authoring-keybindings-title"
      className="space-y-3 rounded-lg border p-4"
    >
      <h2 id="authoring-keybindings-title" tabIndex={-1} className="text-sm font-medium">
        Document and math shortcuts
      </h2>
      <p className="text-xs text-muted-foreground">
        Saved in this browser or desktop profile, shared by its editors. Application bindings above
        retain their environment scope. The focused document owns its commands; PDF read mode never
        inserts math.
      </p>
      {snapshot.migrated ? (
        <p role="status" className="text-xs">
          Legacy math shortcuts loaded. Your next save writes the shared format and keeps the
          original data.
        </p>
      ) : null}
      {snapshot.error || error ? (
        <p role="alert" className="text-xs text-destructive">
          {error || snapshot.error}
        </p>
      ) : null}
      <label className="text-xs">
        Category{" "}
        <select
          aria-label="Authoring shortcut category"
          value={category}
          onChange={(event) => setCategory(event.target.value)}
        >
          <option value="all">All documents</option>
          <option value="markdown">Markdown</option>
          <option value="math">Math / TeX</option>
          <option value="pdf">PDF</option>
        </select>
      </label>
      <p className="text-xs text-muted-foreground">
        PDF document zoom uses Alt+Up / Alt+Down and Alt+0 by default. Cmd/Ctrl + plus, minus, or 0
        remains browser/application zoom. Native menus and operating-system shortcuts can intercept
        custom bindings before Scient receives them.
      </p>
      {editing ? (
        <div className="space-y-2 rounded border p-3" data-keybinding-capture="">
          <h3 className="text-sm">
            Edit {commands.find((command) => command.id === editing.id)?.label}
          </h3>
          <p className="text-xs text-muted-foreground">
            Separate alternatives with commas; separate sequence strokes with spaces. Empty disables
            this command. Saving replaces all its bindings.
          </p>
          <Input
            ref={recorderInput}
            aria-label="Authoring shortcut keys"
            value={editing.draft}
            onChange={(event) => setEditing({ ...editing, draft: event.target.value })}
            onKeyDown={(event) => {
              if (!recording) return;
              event.preventDefault();
              event.stopPropagation();
              if (event.key === "Escape") {
                setRecording(false);
                return;
              }
              if (event.repeat) return;
              const stroke = eventStroke(event.nativeEvent, true);
              if (!stroke) return;
              const portable = stroke.replace(mac ? /^meta\+/u : /^ctrl\+/u, "mod+");
              setEditing({
                ...editing,
                draft: editing.draft ? editing.draft + " " + portable : portable,
              });
            }}
          />
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setRecording(!recording);
                if (!recording) {
                  setEditing({ ...editing, draft: "" });
                  recorderInput.current?.focus();
                }
              }}
            >
              {recording ? "Stop recording" : "Record sequence"}
            </Button>
            <Button
              size="sm"
              onClick={() => {
                if (
                  save(
                    {
                      ...editing.snapshot.preferences,
                      overrides: {
                        ...editing.snapshot.preferences.overrides,
                        [editing.id]: editingKeys,
                      },
                    },
                    editing.snapshot,
                  )
                ) {
                  setEditing(null);
                  setRecording(false);
                }
              }}
            >
              Save shortcut
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setEditing(null);
                setRecording(false);
                setError("");
              }}
            >
              Cancel
            </Button>
          </div>
          {appOverlaps.length ? (
            <p role="status" className="text-xs">
              Contextual overlap with application commands: {[...new Set(appOverlaps)].join(", ")}.
              This authoring command takes priority only in its focused surface.
            </p>
          ) : null}
          {editingKeys.some((key) => /(?:mod|meta)\+m(?: |$)|ctrl\+space/u.test(key)) ? (
            <p className="text-xs">
              These keys can also be reserved by the operating system or input method. Keep a usable
              alternative or use the toolbar.
            </p>
          ) : null}
        </div>
      ) : null}
      <div className="max-h-96 overflow-auto">
        <table className="w-full text-left text-xs">
          <thead>
            <tr>
              <th className="p-2">Action / scope</th>
              <th className="p-2">Effective shortcut</th>
              <th className="p-2">Customize</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((command) => {
              const keys = effective
                .filter((binding) => binding.command === command.id)
                .map((binding) => binding.keys);
              return (
                <tr key={command.id} className="border-t">
                  <td className="p-2">
                    {command.label}
                    <div className="text-muted-foreground">
                      {command.scope} · {command.id}
                    </div>
                  </td>
                  <td className="p-2">
                    {keys.length ? keys.map((key) => labelKeys(key, mac)).join(" / ") : "Unbound"}
                    <div className="text-muted-foreground">
                      {command.id in snapshot.preferences.overrides
                        ? keys.length
                          ? "Custom"
                          : "Disabled"
                        : "Default"}
                    </div>
                  </td>
                  <td className="p-2">
                    <div className="flex gap-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={"Edit " + command.id}
                        onClick={() => {
                          setEditing({ id: command.id, draft: keys.join(", "), snapshot });
                          setRecording(false);
                          setError("");
                        }}
                      >
                        Edit
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={"Disable " + command.id}
                        onClick={() =>
                          update({
                            overrides: { ...snapshot.preferences.overrides, [command.id]: [] },
                          })
                        }
                      >
                        Disable
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={"Reset " + command.id}
                        onClick={() => resetCommand(command.id)}
                      >
                        Reset
                      </Button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {!visible.length ? <p className="p-2 text-xs">No matching document commands.</p> : null}
      </div>
      <details className="space-y-2 text-xs">
        <summary>Math input behavior and preset</summary>
        <p className="text-muted-foreground">
          These control authoring behavior, not application shortcuts. Explicit custom bindings
          override the preset.
        </p>
        <label className="block">
          Math preset{" "}
          <select
            aria-label="Math shortcut preset"
            value={snapshot.preferences.mathPreset}
            onChange={(event) =>
              update({ mathPreset: event.target.value as KeyboardPreferences["mathPreset"] })
            }
          >
            <option value="lyx">Supported LyX-style math sequences</option>
            <option value="minimal">Minimal: palette and equation insertion</option>
          </select>
        </label>
        <label className="block">
          Command completion{" "}
          <select
            aria-label="Math command completion"
            value={snapshot.preferences.completion}
            onChange={(event) =>
              update({ completion: event.target.value as KeyboardPreferences["completion"] })
            }
          >
            <option value="space-tab">Space and Tab</option>
            <option value="tab">Tab only</option>
            <option value="off">Off</option>
          </select>
        </label>
        <label className="block">
          <input
            type="checkbox"
            checked={snapshot.preferences.automaticOperators}
            onChange={(event) => update({ automaticOperators: event.target.checked })}
          />{" "}
          Replace typed math operators such as -&gt;
        </label>
        <label className="block">
          <input
            type="checkbox"
            checked={snapshot.preferences.matrixEnter}
            onChange={(event) => update({ matrixEnter: event.target.checked })}
          />{" "}
          Enter adds a row inside a supported matrix
        </label>
        <label className="block">
          Sequence timeout{" "}
          <select
            aria-label="Shortcut sequence timeout"
            value={snapshot.preferences.sequenceTimeoutMs}
            onChange={(event) => update({ sequenceTimeoutMs: Number(event.target.value) })}
          >
            {[...new Set([1000, 2500, 5000, 10000, snapshot.preferences.sequenceTimeoutMs])]
              .sort((a, b) => a - b)
              .map((ms) => (
                <option key={ms} value={ms}>
                  {ms / 1000} seconds
                </option>
              ))}
          </select>
        </label>
      </details>
      <details className="space-y-2 text-xs">
        <summary>Import, export, or restore document shortcuts</summary>
        <p>
          Versioned authoring preferences or legacy math JSON. This does not change environment
          keybindings.json.
        </p>
        <input
          aria-label="Import authoring shortcuts"
          type="file"
          accept=".json,application/json"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (!file) return;
            const expected = snapshot;
            if (file.size > 100000) {
              setError("Shortcut file is too large.");
              return;
            }
            void file
              .text()
              .then((text) => {
                importKeyboardPreferences(text);
                setImportDraft({ text, snapshot: expected });
                setError("");
              })
              .catch((cause) =>
                setError(cause instanceof Error ? cause.message : "Import failed."),
              );
          }}
        />
        {importDraft ? (
          <div>
            <textarea
              className="w-full rounded border p-2 font-mono"
              rows={6}
              aria-label="Imported shortcut preferences"
              value={importDraft.text}
              onChange={(event) => setImportDraft({ ...importDraft, text: event.target.value })}
            />
            <Button
              size="sm"
              onClick={() => {
                try {
                  if (save(importKeyboardPreferences(importDraft.text), importDraft.snapshot))
                    setImportDraft(null);
                } catch (cause) {
                  setError(cause instanceof Error ? cause.message : "Invalid import.");
                }
              }}
            >
              Apply import
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setImportDraft(null)}>
              Cancel import
            </Button>
          </div>
        ) : null}
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
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
            Export document shortcuts
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              if (
                window.confirm(
                  "Restore document and math shortcut defaults in this profile? Application bindings are unchanged.",
                )
              )
                save(DEFAULT_KEYBOARD_PREFERENCES);
            }}
          >
            Restore document defaults
          </Button>
        </div>
      </details>
      <p className="text-xs text-muted-foreground">
        Arrow keys, clipboard, ordinary typing, and native editor history remain owned by the
        focused editor. System-wide capture shortcuts remain in Capture settings. Visual-specific
        commands become available only through a supported editor adapter.
      </p>
    </section>
  );
}
