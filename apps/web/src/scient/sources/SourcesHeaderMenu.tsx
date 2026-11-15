import type { EnvironmentId } from "@t3tools/contracts";
import {
  ClipboardList,
  CopyCheck,
  FileDown,
  FolderInput,
  HardDriveDownload,
  HardDriveUpload,
  History,
  LibraryBig,
  ListChecks,
  LoaderCircle,
  MoreHorizontal,
  PenLine,
  RefreshCw,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { useRef, useState } from "react";

import { Button } from "../../components/ui/button";
import {
  Menu,
  MenuItem,
  MenuItemDetail,
  MenuPopup,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "../../components/ui/menu";
import { ReferenceCheckDialog } from "../references/ReferenceCheckDialog";
import { BACKUP_LABELS, JOIN_LABELS, RESTORE_LABELS } from "./libraryBackupLabels";
import { RECENT_CHANGES_LABELS } from "./recentChangeLabels";
import { CitationStylePicker } from "./CitationStylePicker";
import { DUPLICATE_LABELS } from "./libraryDuplicateLabels";
import { MoveBackDialog } from "./LibraryMoveNotice";
import { RecoverPreMoveItem, SaveProjectPackageItem } from "./ProjectPackageMenu";
import { SourceTrashPopover } from "./SourceTrash";
import {
  SourcesExportSubmenu,
  useSourcesExport,
  type SourcesExportScope,
} from "./SourcesExportMenu";

/**
 * The Library header's tools, kept in one menu so the title and Import always fit. Its groups:
 * research, output, records, then one submenu for backup and recovery.
 */
export function SourcesHeaderMenu(props: {
  readonly environmentId: EnvironmentId;
  readonly root: string;
  readonly totalCount: number;
  readonly exportScope: SourcesExportScope | null;
  readonly trashedCount: number;
  /** The Library changed (Trash, a recovery): the list reads it again. */
  readonly onTrashChanged: () => Promise<unknown>;
  readonly missingPdfCount: number;
  readonly onGetMissingPdfs: () => void;
  readonly onOpenReviews: () => void;
  /** Present only on a personal Library. */
  readonly onOpenDuplicates?: () => void;
  /** Present only when sources came from Zotero and the session may change the Library. */
  readonly onRefreshZotero?: () => void;
  readonly onOpenSource: (sourceId: string) => void;
  readonly onOpenFile?: (path: string, line: number) => void;
  /** Present only on a moved project and for a session that may change the Library. */
  readonly onMoveBack?: () => void;
  /** On a personal Library for a session that may change it: Save a project package, Recover. */
  readonly canChangeProject?: boolean;
  /** Present only on a personal Library. */
  readonly onOpenRecentChanges?: () => void;
  /** Present only where a folder on the Library's computer can be chosen. */
  readonly onBackUp?: () => void;
  readonly onRestore?: () => void;
  readonly onAddFromLibrary?: () => void;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const [confirmingMoveBack, setConfirmingMoveBack] = useState(false);
  const [checkingReferences, setCheckingReferences] = useState(false);
  const [trashOpen, setTrashOpen] = useState(false);
  const [pickingStyle, setPickingStyle] = useState(false);
  const exporter = useSourcesExport({
    environmentId: props.environmentId,
    root: props.root,
    scope: props.exportScope,
  });
  const backups = Boolean(props.onBackUp || props.onRestore || props.onAddFromLibrary);
  const recovery = Boolean(props.canChangeProject || props.onMoveBack);
  return (
    <>
      <Menu>
        <MenuTrigger
          render={
            <Button
              ref={trigger}
              size="icon-xs"
              variant="ghost"
              aria-label="More Library actions"
            />
          }
        >
          {exporter.exporting ? <LoaderCircle className="animate-spin" /> : <MoreHorizontal />}
        </MenuTrigger>
        <MenuPopup align="end" side="bottom" className="min-w-48">
          <MenuItem onClick={() => setCheckingReferences(true)}>
            <ListChecks />
            Check references
          </MenuItem>
          <MenuItem onClick={props.onOpenReviews}>
            <ClipboardList />
            Systematic reviews
          </MenuItem>
          {props.onOpenDuplicates ? (
            <MenuItem onClick={props.onOpenDuplicates}>
              <CopyCheck />
              {DUPLICATE_LABELS.menuItem}
            </MenuItem>
          ) : null}
          {props.missingPdfCount > 0 ? (
            <MenuItem onClick={props.onGetMissingPdfs}>
              <FileDown />
              {props.missingPdfCount === 1
                ? "Get the missing PDF"
                : `Get ${props.missingPdfCount} missing PDFs`}
            </MenuItem>
          ) : null}
          {props.onRefreshZotero ? (
            <MenuItem onClick={props.onRefreshZotero}>
              <RefreshCw />
              Refresh from Zotero
            </MenuItem>
          ) : null}
          <MenuSeparator />
          <MenuItem onClick={() => setPickingStyle(true)}>
            <PenLine />
            Citation style…
          </MenuItem>
          {props.totalCount > 0 || props.canChangeProject ? (
            <SourcesExportSubmenu
              exporter={exporter}
              totalCount={props.totalCount}
              scope={props.exportScope}
              {...(props.canChangeProject
                ? {
                    projectPackage: (
                      <SaveProjectPackageItem
                        environmentId={props.environmentId}
                        root={props.root}
                      />
                    ),
                  }
                : {})}
            />
          ) : null}
          {props.onOpenRecentChanges || props.trashedCount > 0 ? <MenuSeparator /> : null}
          {props.onOpenRecentChanges ? (
            <MenuItem onClick={props.onOpenRecentChanges}>
              <History />
              {RECENT_CHANGES_LABELS.menuItem}
            </MenuItem>
          ) : null}
          {props.trashedCount > 0 ? (
            <MenuItem onClick={() => setTrashOpen(true)}>
              <Trash2 />
              Trash
              <MenuItemDetail>{props.trashedCount.toLocaleString()}</MenuItemDetail>
            </MenuItem>
          ) : null}
          {backups || recovery ? (
            <>
              <MenuSeparator />
              <MenuSub>
                <MenuSubTrigger>
                  <ShieldCheck />
                  Backup and recovery
                </MenuSubTrigger>
                <MenuSubPopup className="min-w-56">
                  {props.onBackUp ? (
                    <MenuItem onClick={props.onBackUp}>
                      <HardDriveDownload />
                      {BACKUP_LABELS.menuItem}
                    </MenuItem>
                  ) : null}
                  {props.onRestore ? (
                    <MenuItem onClick={props.onRestore}>
                      <HardDriveUpload />
                      {RESTORE_LABELS.menuItem}
                    </MenuItem>
                  ) : null}
                  {props.onAddFromLibrary ? (
                    <MenuItem onClick={props.onAddFromLibrary}>
                      <LibraryBig />
                      {JOIN_LABELS.menuItem}
                    </MenuItem>
                  ) : null}
                  {backups && recovery ? <MenuSeparator /> : null}
                  {recovery ? (
                    <RecoverPreMoveItem
                      environmentId={props.environmentId}
                      root={props.root}
                      onRecovered={props.onTrashChanged}
                    />
                  ) : null}
                  {props.onMoveBack ? (
                    <MenuItem onClick={() => setConfirmingMoveBack(true)}>
                      <FolderInput />
                      Keep this project's sources in its folder
                    </MenuItem>
                  ) : null}
                </MenuSubPopup>
              </MenuSub>
            </>
          ) : null}
        </MenuPopup>
      </Menu>
      <SourceTrashPopover
        environmentId={props.environmentId}
        root={props.root}
        open={trashOpen}
        anchor={trigger}
        onOpenChange={setTrashOpen}
        onChanged={props.onTrashChanged}
      />
      {props.onMoveBack ? (
        <MoveBackDialog
          open={confirmingMoveBack}
          onClose={() => setConfirmingMoveBack(false)}
          onConfirm={props.onMoveBack}
        />
      ) : null}
      {pickingStyle ? (
        <CitationStylePicker
          project={{ environmentId: props.environmentId, root: props.root }}
          onClose={() => setPickingStyle(false)}
        />
      ) : null}
      {checkingReferences ? (
        <ReferenceCheckDialog
          environmentId={props.environmentId}
          root={props.root}
          initialTarget={{ kind: "library" }}
          onOpenSource={(sourceId) => {
            setCheckingReferences(false);
            props.onOpenSource(sourceId);
          }}
          {...(props.onOpenFile
            ? {
                onOpenFile: (path: string, line: number) => {
                  setCheckingReferences(false);
                  props.onOpenFile?.(path, line);
                },
              }
            : {})}
          onClose={() => setCheckingReferences(false)}
        />
      ) : null}
    </>
  );
}
