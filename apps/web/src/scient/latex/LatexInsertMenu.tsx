import { BookOpen, Image as ImageIcon, NotebookText, Shapes, Tag } from "lucide-react";
import type { ReactNode } from "react";

import { MenuSeparator, MenuSub, MenuSubPopup, MenuSubTrigger } from "~/components/ui/menu";
import { WritingCommandIcon } from "../writing/commandIcons";
import {
  InsertMenu,
  InsertMenuContent,
  type InsertMenuAction,
  type InsertMenuLayout,
} from "../writing/InsertMenu";

export interface LatexInsertAction extends InsertMenuAction {
  description: string;
  group: string;
}

const STATEMENTS = [
  "theorem",
  "lemma",
  "proposition",
  "corollary",
  "claim",
  "definition",
  "example",
  "remark",
  "proof",
];
const SUBMENU = { "data-latex-insert-menu": "", "data-dock-command-scope": "latex" } as const;
/** The first level reads like Markdown's Insert menu: one quiet icon per row. */
const ICON = "size-4 text-muted-foreground";
const ICONS: Readonly<Record<string, ReactNode>> = {
  figure: <ImageIcon className={ICON} />,
  citation: <BookOpen className={ICON} />,
  reference: <Tag className={ICON} />,
  footnote: <NotebookText className={ICON} />,
  link: <WritingCommandIcon command="link" className={ICON} />,
};
const withIcons = (actions: readonly LatexInsertAction[]): readonly LatexInsertAction[] =>
  actions.map((action) => (action.icon ? action : { ...action, icon: ICONS[action.id] }));

/** LaTeX's arrangement of the shared Insert menu. */
function latexInsertLayout(): InsertMenuLayout {
  return (item, table) => (
    <>
      {item("figure")}
      {table}
      {item("code")}
      {item("verbatim")}
      <MenuSeparator />
      <MenuSub>
        <MenuSubTrigger>
          <BookOpen className={ICON} />
          <span>References</span>
        </MenuSubTrigger>
        <MenuSubPopup {...SUBMENU}>
          {["citation", "reference", "link"].map(item)}
          <MenuSeparator />
          {item("footnote")}
        </MenuSubPopup>
      </MenuSub>
      <MenuSub>
        <MenuSubTrigger>
          <Shapes className={ICON} />
          <span>Theorems &amp; proofs</span>
        </MenuSubTrigger>
        <MenuSubPopup {...SUBMENU}>
          {STATEMENTS.slice(0, 5).map(item)}
          <MenuSeparator />
          {STATEMENTS.slice(5, 8).map(item)}
          <MenuSeparator />
          {item("proof")}
        </MenuSubPopup>
      </MenuSub>
      <MenuSub>
        <MenuSubTrigger>Document blocks</MenuSubTrigger>
        <MenuSubPopup {...SUBMENU}>
          {["abstract", "contents", "bibliography"].map(item)}
        </MenuSubPopup>
      </MenuSub>
      <MenuSeparator />
      {item("pagebreak")}
    </>
  );
}

/** The regular and overflow menus share the same categories and command availability. */
export function LatexInsertMenuContent(props: {
  actions: readonly LatexInsertAction[];
  onInsertTable: (rows: number, columns: number) => void;
  unavailableReason?: string | undefined;
  onRun?: (command: () => void) => void;
}) {
  return (
    <InsertMenuContent
      actions={withIcons(props.actions)}
      layout={latexInsertLayout()}
      onInsertTable={props.onInsertTable}
      unavailableReason={props.unavailableReason}
      onRun={props.onRun}
    />
  );
}

export function LatexInsertMenu(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  actions: readonly LatexInsertAction[];
  disabled: boolean;
  unavailableReason?: string | undefined;
  onInsertTable: (rows: number, columns: number) => void;
  onReturnFocus: () => void;
}) {
  return (
    <InsertMenu
      open={props.open}
      onOpenChange={props.onOpenChange}
      actions={withIcons(props.actions)}
      layout={latexInsertLayout()}
      disabled={props.disabled}
      unavailableReason={props.unavailableReason}
      onInsertTable={props.onInsertTable}
      onReturnFocus={props.onReturnFocus}
      popupAttributes={{ "data-latex-insert-menu": "" }}
    />
  );
}
