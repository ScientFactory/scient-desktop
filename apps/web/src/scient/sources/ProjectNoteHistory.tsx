import type { ScientSourceDetailResult } from "@t3tools/contracts";
import { msg, T, useMessages } from "gt-react";

import type { MessageResolver } from "~/i18n/messages";

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

function versionLabel(version: NoteVersion, resolve: MessageResolver): string {
  const when = new Date(version.at).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
  const who =
    version.kind === "found"
      ? resolve(msg("found in the project", { $context: "where a note version came from" }))
      : version.by === "agent"
        ? resolve(msg("agent", { $context: "who wrote a note version" }))
        : version.by === "user"
          ? resolve(msg("you", { $context: "who wrote a note version" }))
          : null;
  return who ? `${when} · ${who}` : when;
}

function preview(note: string | null, resolve: MessageResolver): string {
  const line = note?.replace(/[*_]/gu, "").trim().split("\n")[0]?.trim();
  return line || resolve(msg("No note"));
}

/** The project note's earlier versions, newest first; choosing one saves it as a new change. */
export function ProjectNoteHistory(props: {
  readonly versions: ScientSourceDetailResult["projectNoteHistory"];
  readonly onRestore: (note: string) => void;
}) {
  const m = useMessages();
  // The last version is the note shown above.
  const earlier = (props.versions ?? []).slice(0, -1).toReversed();
  if (earlier.length === 0) return null;
  return (
    <Menu>
      <MenuTrigger render={<Button size="xs" variant="ghost" />}>
        <T>Earlier versions</T>
      </MenuTrigger>
      <MenuPopup align="end" side="bottom" className="max-w-80 min-w-56">
        <MenuGroup>
          <MenuGroupLabel>
            <T>Restore an earlier version</T>
          </MenuGroupLabel>
          {earlier.map((version) => (
            <MenuItem
              key={`${version.at}-${version.kind}-${version.by ?? ""}`}
              onClick={() => props.onRestore(version.note ?? "")}
            >
              <span className="min-w-0 flex-1 truncate">{preview(version.note, m)}</span>
              <MenuItemDetail>{versionLabel(version, m)}</MenuItemDetail>
            </MenuItem>
          ))}
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}
