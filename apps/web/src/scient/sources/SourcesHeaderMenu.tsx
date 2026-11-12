import type { EnvironmentId } from "@t3tools/contracts";
import {
  ClipboardList,
  CopyCheck,
  FileDown,
  ListChecks,
  LoaderCircle,
  MessageCircleQuestionIcon,
  MoreHorizontal,
  PenLine,
  Trash2,
  Undo2,
} from "lucide-react";
import { useRef, useState } from "react";

import { Button } from "../../components/ui/button";
import {
  Menu,
  MenuItem,
  MenuItemDetail,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "../../components/ui/menu";
import { toastManager } from "../../components/ui/toast";
import { useComposerHandleContext } from "../../composerHandleContext";
import { ReferenceCheckDialog } from "../references/ReferenceCheckDialog";
import { askLibraryInsertion } from "./askLibrary";
import { CitationStylePicker } from "./CitationStylePicker";
import { DUPLICATE_LABELS } from "./libraryDuplicateLabels";
import { MoveBackDialog } from "./LibraryMoveNotice";
import { SourceTrashPopover } from "./SourceTrash";
import {
  SourcesExportSubmenu,
  useSourcesExport,
  type SourcesExportScope,
} from "./SourcesExportMenu";

/** The Library header's secondary actions, kept in one menu so the title and Import always fit. */
export function SourcesHeaderMenu(props: {
  readonly environmentId: EnvironmentId;
  readonly root: string;
  readonly totalCount: number;
  readonly exportScope: SourcesExportScope | null;
  readonly trashedCount: number;
  readonly onTrashChanged: () => Promise<unknown>;
  readonly missingPdfCount: number;
  readonly onGetMissingPdfs: () => void;
  readonly onOpenReviews: () => void;
  /** Present only on a personal Library. */
  readonly onOpenDuplicates?: () => void;
  readonly onOpenSource: (sourceId: string) => void;
  readonly onOpenFile?: (path: string, line: number) => void;
  /** Present only on a moved project and for a session that may change the Library. */
  readonly onMoveBack?: () => void;
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
  const composer = useComposerHandleContext();
  // Set when Ask put the caret in the composer, so closing the menu leaves it there.
  const composerFocused = useRef(false);
  const askLibrary = () => {
    const handle = composer?.current;
    const draft = handle?.getSendContext();
    if (handle && draft && !draft.answeringPendingUserInput) {
      const insertion = askLibraryInsertion(draft.prompt);
      if (insertion === null) {
        handle.focusAtEnd();
        composerFocused.current = true;
        return;
      }
      if (handle.insertTextAtStart?.(insertion)) {
        composerFocused.current = true;
        return;
      }
    }
    toastManager.add({
      type: "error",
      title: "Couldn't add to the chat",
      description: draft?.answeringPendingUserInput
        ? "Answer the agent's question first, then try again."
        : "The chat isn't ready for text right now.",
    });
  };
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
        <MenuPopup
          align="end"
          side="bottom"
          className="min-w-48"
          finalFocus={() => {
            const keepComposerFocus = composerFocused.current;
            composerFocused.current = false;
            return !keepComposerFocus;
          }}
        >
          {props.totalCount > 0 ? (
            <MenuItem
              disabled={composer === null}
              {...(composer === null ? { title: "Open a chat to ask the Library." } : {})}
              onClick={askLibrary}
            >
              <MessageCircleQuestionIcon />
              Ask the Library
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
          <MenuItem onClick={() => setPickingStyle(true)}>
            <PenLine />
            Citation style…
          </MenuItem>
          {props.totalCount > 0 ? (
            <SourcesExportSubmenu
              exporter={exporter}
              totalCount={props.totalCount}
              scope={props.exportScope}
            />
          ) : null}
          {props.onMoveBack ? (
            <MenuItem onClick={() => setConfirmingMoveBack(true)}>
              <Undo2 />
              Move back into this project
            </MenuItem>
          ) : null}
          {props.trashedCount > 0 ? (
            <>
              <MenuSeparator />
              <MenuItem onClick={() => setTrashOpen(true)}>
                <Trash2 />
                Trash
                <MenuItemDetail>{props.trashedCount.toLocaleString()}</MenuItemDetail>
              </MenuItem>
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
