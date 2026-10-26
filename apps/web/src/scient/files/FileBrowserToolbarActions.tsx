import { FilePlus2Icon, FolderPlusIcon, FolderSyncIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { Button } from "~/components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import type { NewDocumentFormat } from "~/scient/documents/documentTemplates";
import { NewDocumentMenuItems } from "~/scient/documents/NewDocumentMenuItems";

import type { Icon } from "~/components/Icons";

import { DropboxMark, GoogleDriveMark, OneDriveMark, OverleafMark } from "./ExternalFolderMarks";

/** Extra controls the Files bar can carry, such as a tab's Back and Forward. */
export type ScientToolbarSlot = ReactNode;

/** The services a project folder will keep in sync with. None is wired up yet. */
const CONNECT_SERVICES: ReadonlyArray<{
  readonly id: string;
  readonly label: string;
  readonly Mark: Icon;
}> = [
  { id: "overleaf", label: "Overleaf", Mark: OverleafMark },
  { id: "google-drive", label: "Google Drive", Mark: GoogleDriveMark },
  { id: "onedrive", label: "OneDrive", Mark: OneDriveMark },
  { id: "dropbox", label: "Dropbox", Mark: DropboxMark },
];

/**
 * An icon that opens its menu on hover, with a safe path for the pointer into
 * the menu. Hovering away closes it; a click keeps it open until a click
 * elsewhere.
 */
function MenuButton(props: {
  readonly label: string;
  readonly icon: ReactNode;
  readonly children: ReactNode;
  readonly onOpenChange?: (open: boolean) => void;
}) {
  return (
    <Menu {...(props.onOpenChange ? { onOpenChange: props.onOpenChange } : {})}>
      <MenuTrigger
        openOnHover
        delay={80}
        closeDelay={150}
        render={
          <Button
            type="button"
            variant="ghost-muted"
            size="icon-xs"
            className="shrink-0"
            aria-label={props.label}
          />
        }
      >
        {props.icon}
      </MenuTrigger>
      {props.children}
    </Menu>
  );
}

/** Starts a Markdown or LaTeX document in the selected folder. */
export function NewDocumentButton(props: {
  readonly onChoose: (format: NewDocumentFormat) => void;
}) {
  return (
    <MenuButton
      label="New document"
      icon={<FilePlus2Icon aria-hidden className="scient-quiet-icon size-4" />}
    >
      <MenuPopup align="start" sideOffset={6} className="min-w-48">
        <NewDocumentMenuItems onChoose={props.onChoose} />
      </MenuPopup>
    </MenuButton>
  );
}

/** Keeps a folder of this project in sync with a place outside it. */
export function ConnectFolderButton() {
  // A service on the way says so where it was clicked, and the menu stays open.
  const [comingSoon, setComingSoon] = useState<string | null>(null);
  return (
    <MenuButton
      label="Connect an external folder"
      icon={<FolderSyncIcon aria-hidden className="scient-quiet-icon size-4" />}
      onOpenChange={(open) => {
        if (!open) setComingSoon(null);
      }}
    >
      <MenuPopup align="start" sideOffset={6} className="min-w-48">
        {/* Each service shows its own mark, and the folder it adds to the project. */}
        {CONNECT_SERVICES.map(({ id, label, Mark }) => (
          <MenuItem key={id} closeOnClick={false} onClick={() => setComingSoon(id)}>
            <Mark aria-hidden className="size-4 opacity-100" />
            <span className="flex-1">{label}</span>
            {comingSoon === id ? (
              <span className="ms-4 text-2xs text-muted-foreground">Coming soon</span>
            ) : (
              <FolderPlusIcon aria-hidden className="ms-4 size-3.5 text-muted-foreground/60" />
            )}
          </MenuItem>
        ))}
      </MenuPopup>
    </MenuButton>
  );
}
