import { msg, useGT, useMessages } from "gt-react";

import { SettingsRow, SettingsSection } from "~/components/settings/settingsLayout";
import { Kbd } from "~/components/ui/kbd";
import { isMacPlatform } from "~/lib/utils";

const COMMANDS: ReadonlyArray<readonly [string, ReadonlyArray<ReadonlyArray<string>>]> = [
  [msg("Run and go to the next cell"), [["Shift", "Enter"]]],
  [msg("Run", { $context: "verb, runs a notebook cell" }), [["Mod", "Enter"]]],
  [msg("Edit the selected cell"), [["Enter"]]],
  [msg("Stop editing"), [["Esc"]]],
  [msg("Previous cell"), [["↑"], ["K"]]],
  [msg("Next cell"), [["↓"], ["J"]]],
  [msg("Add a cell above"), [["A"]]],
  [msg("Add a cell below"), [["B"]]],
  [msg("Delete the cell"), [["D", "D"]]],
  [msg("Undo delete"), [["Z"]]],
  [msg("Make a Text cell"), [["M"]]],
  [msg("Make a Code cell"), [["Y"]]],
  [msg("Interrupt", { $context: "verb, interrupts the running kernel" }), [["I", "I"]]],
];

/** Notebook keys are fixed, as in Jupyter, and act on the selected cell outside its editor. */
export function NotebookShortcuts() {
  const gt = useGT();
  const messages = useMessages();
  const mod = isMacPlatform(navigator.platform) ? "⌘" : "Ctrl";
  return (
    <SettingsSection id="keybindings-notebook" title={gt("Notebook")}>
      {COMMANDS.map(([title, choices]) => (
        <SettingsRow
          key={title}
          title={messages(title)}
          control={
            <span className="flex items-center gap-2">
              {choices.map((keys) => (
                <span key={keys.join("+")} className="flex items-center gap-1">
                  {keys.map((key, index) => (
                    // oxlint-disable-next-line react/no-array-index-key -- D D repeats a key, and the list never changes.
                    <Kbd key={index}>{key === "Mod" ? mod : key}</Kbd>
                  ))}
                </span>
              ))}
            </span>
          }
        />
      ))}
    </SettingsSection>
  );
}
