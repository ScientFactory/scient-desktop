// Renaming a recording in its row and moving it to the Trash, from its menu or a right-click.
import type { ContextMenuItem } from "@t3tools/contracts";
import { useGT } from "gt-react";
import { type MouseEvent, useRef, useState } from "react";

import { Input } from "../../components/ui/input";
import { Popover, PopoverPopup, PopoverTitle } from "../../components/ui/popover";
import { MenuItem, MenuSeparator } from "../../components/ui/menu";
import { toastManager } from "../../components/ui/toast";
import { readLocalApi } from "../../localApi";
import { transcriptionCommand } from "../../rpc/transcription";

type Point = { readonly x: number; readonly y: number };
/** `at` is where a right-click opened the menu. */
export type RecordingAction = Omit<ContextMenuItem, "children"> & {
  readonly run: (at?: Point) => void;
};

/** The same actions as the row's menu, at the pointer. */
export async function showRecordingMenu(event: MouseEvent, actions: readonly RecordingAction[]) {
  const api = readLocalApi();
  if (!api) return;
  event.preventDefault();
  const id = await api.contextMenu.show(
    actions.map(({ run: _run, ...item }) => item),
    { x: event.clientX, y: event.clientY },
  );
  actions.find((action) => action.id === id)?.run({ x: event.clientX, y: event.clientY });
}

export function RecordingMenuItems({ actions }: { readonly actions: readonly RecordingAction[] }) {
  return actions.map((action) => [
    action.separatorBefore ? <MenuSeparator key={`${action.id}-separator`} /> : null,
    <MenuItem
      key={action.id}
      disabled={action.disabled}
      variant={action.destructive ? "destructive" : "default"}
      onClick={() => action.run()}
    >
      {action.label}
    </MenuItem>,
  ]);
}

export type ManagedRecording = {
  readonly workspaceRoot: string;
  readonly source: string;
  readonly title: string;
};

/** The recording's name, edited where it is shown: Enter or leaving saves, Escape cancels. */
export function RecordingNameInput({
  recording,
  onDone,
}: {
  readonly recording: ManagedRecording;
  readonly onDone: (changed: boolean) => void;
}) {
  const gt = useGT();
  const [value, setValue] = useState(recording.title);
  const finished = useRef(false);
  const finish = async (save: boolean) => {
    if (finished.current) return;
    finished.current = true;
    const title = value.trim();
    if (!save || !title || title === recording.title) return onDone(false);
    try {
      await transcriptionCommand("recording-rename", recording.workspaceRoot, {
        source: recording.source,
        title,
      });
      onDone(true);
    } catch {
      toastManager.add({ type: "error", title: gt("Could not rename the recording") });
      onDone(false);
    }
  };
  return (
    <Input
      size="sm"
      // The text stays where the name was.
      className="-ms-2.5"
      aria-label={gt("Name")}
      maxLength={200}
      value={value}
      ref={(input) => {
        if (!input || input.dataset.ready) return;
        input.dataset.ready = "true";
        input.focus();
        input.select();
      }}
      onChange={(event) => setValue(event.currentTarget.value)}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Enter") void finish(true);
        else if (event.key === "Escape") void finish(false);
      }}
      onBlur={() => void finish(true)}
    />
  );
}

/** Moves the recording, its transcripts and notes to the Trash, and says so. */
export async function trashRecording(
  recording: ManagedRecording,
  labels: { readonly done: string; readonly failed: string },
) {
  try {
    await transcriptionCommand("recording-trash", recording.workspaceRoot, {
      source: recording.source,
    });
    toastManager.add({ type: "success", title: labels.done });
    return true;
  } catch {
    toastManager.add({ type: "error", title: labels.failed });
    return false;
  }
}

export type RecordingDetails = {
  readonly title: string;
  readonly rows: readonly (readonly [label: string, value: string | undefined])[];
};

/** A small card of facts about a recording, next to the row or where it was right-clicked. */
export function RecordingInfo({
  details,
  anchor,
  onClose,
}: {
  readonly details: RecordingDetails;
  readonly anchor: Element | { getBoundingClientRect: () => DOMRect };
  readonly onClose: () => void;
}) {
  return (
    <Popover open onOpenChange={(open) => !open && onClose()}>
      <PopoverPopup anchor={anchor} width="sm" side="bottom" align="start">
        <PopoverTitle>{details.title}</PopoverTitle>
        <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-xs">
          {details.rows.map(([label, value]) =>
            value ? (
              <div key={label} className="contents">
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="truncate tabular-nums">{value}</dd>
              </div>
            ) : null,
          )}
        </dl>
      </PopoverPopup>
    </Popover>
  );
}
