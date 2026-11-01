import { SettingsRow, SettingsSection } from "~/components/settings/settingsLayout";
import { Kbd } from "~/components/ui/kbd";
import { isMacPlatform } from "~/lib/utils";

const COMMANDS: ReadonlyArray<readonly [string, ReadonlyArray<ReadonlyArray<string>>]> = [
  ["Run and go to the next cell", [["Shift", "Enter"]]],
  ["Run", [["Mod", "Enter"]]],
  ["Edit the selected cell", [["Enter"]]],
  ["Stop editing", [["Esc"]]],
  ["Previous cell", [["↑"], ["K"]]],
  ["Next cell", [["↓"], ["J"]]],
  ["Add a cell above", [["A"]]],
  ["Add a cell below", [["B"]]],
  ["Delete the cell", [["D", "D"]]],
  ["Undo delete", [["Z"]]],
  ["Make a Text cell", [["M"]]],
  ["Make a Code cell", [["Y"]]],
  ["Interrupt", [["I", "I"]]],
];

/** Notebook keys are fixed, as in Jupyter, and act on the selected cell outside its editor. */
export function NotebookShortcuts() {
  const mod = isMacPlatform(navigator.platform) ? "⌘" : "Ctrl";
  return (
    <SettingsSection id="keybindings-notebook" title="Notebook">
      {COMMANDS.map(([title, choices]) => (
        <SettingsRow
          key={title}
          title={title}
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
