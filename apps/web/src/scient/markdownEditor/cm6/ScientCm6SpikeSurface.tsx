import { redo, undo } from "@codemirror/commands";
import type { MarkdownSaveIntent } from "@scientfactory/scient-markdown";
import { MarkdownSaveQueue } from "@scientfactory/scient-markdown";
import {
  ArrowRightLeft,
  Bold,
  Code,
  CornerDownLeft,
  Heading1,
  Heading2,
  Heading3,
  Heading4,
  Heading5,
  Heading6,
  Image as ImageIcon,
  Italic,
  Link2,
  List,
  ListOrdered,
  ListTodo,
  Minus,
  PilcrowLeft,
  PilcrowRight,
  Plus,
  Redo2,
  Sigma,
  SquareCode,
  Strikethrough,
  Table as TableIcon,
  TextInitial,
  TextQuote,
  Undo2,
} from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import { MenuItem, MenuSeparator, MenuShortcut } from "~/components/ui/menu";

import {
  insertBlockTemplate,
  insertImageTemplate,
  insertLineBreak,
  insertLink,
  setLineBlockStyle,
  toggleDirection,
  toggleLinePrefix,
  toggleNumberedList,
  toggleWrap,
} from "./commands";
import { ScientCm6EditorView } from "./view";
import {
  DockButton,
  DockDivider,
  DockMenu,
  DockOverflowRow,
  type DockGroup,
} from "../ui/dockChrome";
import { ScientFindBar } from "../ui/ScientFindBar";
import { useFinalUnmount } from "../useFinalUnmount";
import "../scient-markdown-editor.css";

const SAVE_DEBOUNCE_MS = 600;

const CODE_BLOCK_TEMPLATE = "```\n\n```";
const MATH_BLOCK_TEMPLATE = "$$\n\n$$";
const TABLE_TEMPLATE = [
  "| Column | Column | Column |",
  "| ------ | ------ | ------ |",
  "|        |        |        |",
  "|        |        |        |",
].join("\n");

type Cm6View = NonNullable<ScientCm6EditorView["view"]>;

const STYLE_ITEMS: ReadonlyArray<{
  readonly label: string;
  readonly icon: React.ReactNode;
  readonly prefix: string | null;
}> = [
  { label: "Paragraph", icon: <TextInitial />, prefix: null },
  { label: "Heading 1", icon: <Heading1 />, prefix: "# " },
  { label: "Heading 2", icon: <Heading2 />, prefix: "## " },
  { label: "Heading 3", icon: <Heading3 />, prefix: "### " },
  { label: "Heading 4", icon: <Heading4 />, prefix: "#### " },
  { label: "Heading 5", icon: <Heading5 />, prefix: "##### " },
  { label: "Heading 6", icon: <Heading6 />, prefix: "###### " },
  { label: "Quote", icon: <TextQuote />, prefix: "> " },
];

export interface ScientCm6SpikeSurfaceProps {
  readonly source: string;
  readonly revision: string;
  readonly ariaLabel: string;
  readonly persist: (intent: MarkdownSaveIntent) => Promise<{ readonly revision: string }>;
  readonly onPendingChange: (pending: boolean) => void;
  readonly onSaveConfirmed: (source: string, revision: string) => void;
  readonly onSaveFailure: (error: unknown) => void;
  readonly onExternalConflict: (input: {
    readonly source: string;
    readonly revision: string;
  }) => void;
  readonly onOpenLink?: (target: string) => void;
  readonly resolveImageSource?: (authoredSource: string) => Promise<string | null>;
  readonly saveResolution?: {
    readonly action: "discard" | "retry";
    readonly revision: string;
  } | null;
  readonly onSaveResolutionApplied?: () => void;
}

/**
 * Dev-only spike surface for the CodeMirror live-preview core. Same file,
 * same save lane, same session contract as the ProseMirror surface, so the
 * feel of both can be compared on real documents.
 */
export function ScientCm6SpikeSurface(props: ScientCm6SpikeSurfaceProps) {
  const persistRef = useRef(props.persist);
  const onPendingChangeRef = useRef(props.onPendingChange);
  const onSaveConfirmedRef = useRef(props.onSaveConfirmed);
  const onSaveFailureRef = useRef(props.onSaveFailure);
  const onExternalConflictRef = useRef(props.onExternalConflict);
  const onSaveResolutionAppliedRef = useRef(props.onSaveResolutionApplied);
  persistRef.current = props.persist;
  onPendingChangeRef.current = props.onPendingChange;
  onSaveConfirmedRef.current = props.onSaveConfirmed;
  onSaveFailureRef.current = props.onSaveFailure;
  onExternalConflictRef.current = props.onExternalConflict;
  onSaveResolutionAppliedRef.current = props.onSaveResolutionApplied;

  const containerRef = useRef<HTMLDivElement>(null);
  const controllerRef = useRef<ScientCm6EditorView | null>(null);
  const [chromeExpanded, setChromeExpanded] = useState(false);

  const [saveQueue] = useState(
    () =>
      new MarkdownSaveQueue({
        debounceMs: SAVE_DEBOUNCE_MS,
        persist: (intent) => persistRef.current(intent),
        onPendingChange: (isPending) => {
          onPendingChangeRef.current(isPending);
        },
        onConfirmed: (intent, result) => {
          controllerRef.current?.confirmSave(intent, result.revision);
          onSaveConfirmedRef.current(intent.source, result.revision);
        },
        onFailure: (_intent, error) => onSaveFailureRef.current(error),
      }),
  );
  const [controller] = useState(
    () =>
      new ScientCm6EditorView({
        source: props.source,
        revision: props.revision,
        placeholder: "Start writing…",
        ...(props.resolveImageSource ? { resolveImageSource: props.resolveImageSource } : {}),
        ...(props.onOpenLink ? { onOpenLink: props.onOpenLink } : {}),
        onUserSourceChange: (_source, intent) => {
          // First real edit reveals the formatting controls.
          setChromeExpanded(true);
          saveQueue.enqueue(intent);
        },
      }),
  );
  controllerRef.current = controller;
  const findSnapshot = useSyncExternalStore(
    controller.subscribeFind,
    controller.getFindSnapshot,
    controller.getFindSnapshot,
  );

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    controller.mount(element);
  }, [controller]);

  useFinalUnmount(() => {
    // The shared pending-save guard owns coordinated departures. This is the
    // final direct-unmount fallback and resource teardown.
    void saveQueue.dispose({ flush: true });
    controller.destroy();
    controllerRef.current = null;
  });

  useEffect(() => {
    const result = controller.receiveExternalSource({
      source: props.source,
      revision: props.revision,
    });
    if (result === "conflict") {
      saveQueue.pause();
      onExternalConflictRef.current({ source: props.source, revision: props.revision });
    } else if (result === "adopted") {
      // Same draft, fresher revision: rebase the queued save intent.
      const rebased = controller.createSaveIntent();
      if (rebased) saveQueue.enqueue(rebased);
    }
  }, [controller, props.revision, props.source, saveQueue]);

  useEffect(() => {
    if (!props.saveResolution) return;
    if (props.saveResolution.action === "discard") {
      saveQueue.discard();
      controller.resolveExternalConflict("disk");
    } else {
      controller.resolveExternalConflict("local");
      saveQueue.retry(props.saveResolution.revision);
    }
    onSaveResolutionAppliedRef.current?.();
  }, [controller, props.saveResolution, saveQueue]);

  const run = (action: (view: Cm6View) => boolean): void => {
    const view = controller.view;
    if (!view) return;
    action(view);
    view.focus();
  };

  const styleItems = (
    <>
      {STYLE_ITEMS.map((entry) => (
        <MenuItem
          key={entry.label}
          onClick={() => run((view) => setLineBlockStyle(view, entry.prefix))}
        >
          {entry.icon}
          <span>{entry.label}</span>
        </MenuItem>
      ))}
    </>
  );
  const listItems = (
    <>
      <MenuItem onClick={() => run((view) => toggleLinePrefix(view, "- "))}>
        <List />
        <span>Bullet list</span>
      </MenuItem>
      <MenuItem onClick={() => run(toggleNumberedList)}>
        <ListOrdered />
        <span>Numbered list</span>
      </MenuItem>
      <MenuItem onClick={() => run((view) => toggleLinePrefix(view, "- [ ] "))}>
        <ListTodo />
        <span>Task list</span>
      </MenuItem>
    </>
  );
  const insertItems = (
    <>
      <MenuItem onClick={() => run((view) => insertBlockTemplate(view, TABLE_TEMPLATE))}>
        <TableIcon />
        <span>Table (3×3)</span>
      </MenuItem>
      <MenuItem onClick={() => run((view) => insertBlockTemplate(view, CODE_BLOCK_TEMPLATE))}>
        <SquareCode />
        <span>Code block</span>
      </MenuItem>
      <MenuItem onClick={() => run((view) => insertBlockTemplate(view, MATH_BLOCK_TEMPLATE))}>
        <Sigma />
        <span>Math equation ($$)</span>
      </MenuItem>
      <MenuItem onClick={() => run(insertImageTemplate)}>
        <ImageIcon />
        <span>Image</span>
      </MenuItem>
      <MenuItem onClick={() => run((view) => insertBlockTemplate(view, "\n---\n"))}>
        <Minus />
        <span>Divider line</span>
      </MenuItem>
      <MenuSeparator />
      <MenuItem onClick={() => run(insertLineBreak)}>
        <CornerDownLeft />
        <span>Line break</span>
        <MenuShortcut>⇧↩</MenuShortcut>
      </MenuItem>
    </>
  );
  const directionItems = (
    <>
      <MenuItem onClick={() => run((view) => toggleDirection(view, null))}>
        <ArrowRightLeft />
        <span>Auto</span>
      </MenuItem>
      <MenuItem onClick={() => run((view) => toggleDirection(view, "ltr"))}>
        <PilcrowRight />
        <span>Left-to-right</span>
      </MenuItem>
      <MenuItem onClick={() => run((view) => toggleDirection(view, "rtl"))}>
        <PilcrowLeft />
        <span>Right-to-left</span>
      </MenuItem>
    </>
  );

  // Same overflow contract as the ProseMirror dock: direction collapses
  // first, inline formatting is pinned, hidden groups move into the ⋯ menu.
  const dockGroups: readonly DockGroup[] = [
    {
      id: "history",
      priority: 30,
      estimatedWidth: 70,
      bar: (
        <>
          <DockButton
            label="Undo (Cmd+Z)"
            icon={<Undo2 className="size-4" />}
            onClick={() => run(undo)}
          />
          <DockButton
            label="Redo (Cmd+Shift+Z)"
            icon={<Redo2 className="size-4" />}
            onClick={() => run(redo)}
          />
          <DockDivider />
        </>
      ),
      overflowLabel: "History",
      overflow: (
        <>
          <MenuItem onClick={() => run(undo)}>
            <Undo2 />
            <span>Undo</span>
            <MenuShortcut>⌘Z</MenuShortcut>
          </MenuItem>
          <MenuItem onClick={() => run(redo)}>
            <Redo2 />
            <span>Redo</span>
            <MenuShortcut>⇧⌘Z</MenuShortcut>
          </MenuItem>
        </>
      ),
    },
    {
      id: "format",
      priority: 100,
      pinned: true,
      estimatedWidth: 160,
      bar: (
        <>
          <DockButton
            label="Bold (Cmd+B)"
            icon={<Bold className="size-4" strokeWidth={2.5} />}
            onClick={() => run((view) => toggleWrap(view, "**"))}
          />
          <DockButton
            label="Italic (Cmd+I)"
            icon={<Italic className="size-4" />}
            onClick={() => run((view) => toggleWrap(view, "*"))}
          />
          <DockButton
            label="Strikethrough (Cmd+Shift+X)"
            icon={<Strikethrough className="size-4" />}
            onClick={() => run((view) => toggleWrap(view, "~~"))}
          />
          <DockButton
            label="Inline Code (Cmd+E)"
            icon={<Code className="size-4" />}
            onClick={() => run((view) => toggleWrap(view, "`"))}
          />
          <DockButton
            label="Link (Cmd+K)"
            icon={<Link2 className="size-4" />}
            onClick={() => run(insertLink)}
          />
          <DockDivider />
        </>
      ),
    },
    {
      id: "style",
      priority: 50,
      estimatedWidth: 44,
      bar: (
        <DockMenu
          label="Paragraph style"
          icon={<TextInitial className="size-4" />}
          groupLabel="Style"
        >
          {styleItems}
        </DockMenu>
      ),
      overflowLabel: "Style",
      overflow: styleItems,
    },
    {
      id: "lists",
      priority: 40,
      estimatedWidth: 48,
      bar: (
        <>
          <DockMenu label="List style" icon={<List className="size-4" />} groupLabel="Lists">
            {listItems}
          </DockMenu>
          <DockDivider />
        </>
      ),
      overflowLabel: "Lists",
      overflow: listItems,
    },
    {
      id: "insert",
      priority: 20,
      estimatedWidth: 48,
      bar: (
        <>
          <DockMenu
            label="Insert block or element"
            icon={<Plus className="size-4" />}
            groupLabel="Insert"
            popupClassName="w-52"
          >
            {insertItems}
          </DockMenu>
          <DockDivider />
        </>
      ),
      overflowLabel: "Insert",
      overflow: insertItems,
    },
    {
      id: "direction",
      priority: 10,
      estimatedWidth: 44,
      bar: (
        <DockMenu
          label="Text direction"
          icon={<ArrowRightLeft className="size-4" />}
          groupLabel="Text direction"
        >
          {directionItems}
        </DockMenu>
      ),
      overflowLabel: "Text direction",
      overflow: directionItems,
    },
  ];

  return (
    <div
      className="scient-cm6-spike flex h-full flex-col"
      aria-label={props.ariaLabel}
      style={{ position: "relative" }}
    >
      <DockOverflowRow
        label="Markdown editing controls"
        expanded={chromeExpanded}
        onExpandedChange={setChromeExpanded}
        groups={dockGroups}
      />
      {findSnapshot.findOpen ? (
        <ScientFindBar controller={controller} snapshot={findSnapshot} />
      ) : null}
      <div ref={containerRef} className="min-h-0 flex-1" />
    </div>
  );
}
