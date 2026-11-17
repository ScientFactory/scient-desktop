import type { ScientSourceDetailResult } from "@t3tools/contracts";

import { Button } from "../../components/ui/button";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuItemDetail,
  MenuPopup,
  MenuTrigger,
} from "../../components/ui/menu";

type NoteVersion = NonNullable<ScientSourceDetailResult["projectNoteHistory"]>[number];

function versionLabel(version: NoteVersion): string {
  const when = new Date(version.at).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
  const who =
    version.kind === "found"
      ? "found in the project"
      : version.by === "agent"
        ? "agent"
        : version.by === "user"
          ? "you"
          : null;
  return who ? `${when} · ${who}` : when;
}

function preview(note: string | null): string {
  const line = note?.replace(/[*_]/gu, "").trim().split("\n")[0]?.trim();
  return line || "No note";
}

/** The project note's earlier versions, newest first; choosing one saves it as a new change. */
export function ProjectNoteHistory(props: {
  readonly versions: ScientSourceDetailResult["projectNoteHistory"];
  readonly onRestore: (note: string) => void;
}) {
  // The last version is the note shown above.
  const earlier = (props.versions ?? []).slice(0, -1).toReversed();
  if (earlier.length === 0) return null;
  return (
    <Menu>
      <MenuTrigger render={<Button size="xs" variant="ghost" />}>Earlier versions</MenuTrigger>
      <MenuPopup align="end" side="bottom" className="max-w-80 min-w-56">
        <MenuGroup>
          <MenuGroupLabel>Restore an earlier version</MenuGroupLabel>
          {earlier.map((version) => (
            <MenuItem
              key={`${version.at}-${version.kind}-${version.by ?? ""}`}
              onClick={() => props.onRestore(version.note ?? "")}
            >
              <span className="min-w-0 flex-1 truncate">{preview(version.note)}</span>
              <MenuItemDetail>{versionLabel(version)}</MenuItemDetail>
            </MenuItem>
          ))}
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}
