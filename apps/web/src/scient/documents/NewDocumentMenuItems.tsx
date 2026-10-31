import { MenuItem } from "~/components/ui/menu";

import type { NewDocumentFormat } from "./documentTemplates";

/** Each kind of document, with the words that tell it apart. */
export const NEW_DOCUMENT_FORMATS = {
  markdown: { label: "Markdown", hint: "Notes · Word · PDF" },
  latex: { label: "LaTeX", hint: "Papers · PDF" },
} as const satisfies Record<NewDocumentFormat, { label: string; hint: string }>;

export type NewDocumentChoice = NewDocumentFormat | "notebook";

export function NewDocumentMenuItems(props: {
  readonly onChoose: (choice: NewDocumentChoice) => void;
}) {
  return (
    <>
      {(["markdown", "latex"] as const).map((format) => (
        <MenuItem key={format} onClick={() => props.onChoose(format)}>
          <span className="flex-1">{NEW_DOCUMENT_FORMATS[format].label}</span>
          <span className="ps-4 text-2xs text-muted-foreground/45">
            {NEW_DOCUMENT_FORMATS[format].hint}
          </span>
        </MenuItem>
      ))}
      <MenuItem onClick={() => props.onChoose("notebook")}>
        <span className="flex-1">Notebook</span>
        <span className="ps-4 text-2xs text-muted-foreground/45">Code · Results</span>
      </MenuItem>
    </>
  );
}
