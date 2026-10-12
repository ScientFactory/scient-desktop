import {
  Bold,
  Code,
  Italic,
  Link2,
  List,
  ListOrdered,
  ListX,
  Plus,
  Redo2,
  TextInitial,
  TextQuote,
  Undo2,
} from "lucide-react";

import type { WritingCommandId } from "./commandNames";

/** The one icon for each shared writing command; see `commandNames.ts`. */
export function WritingCommandIcon(props: {
  readonly command: WritingCommandId;
  readonly className?: string;
}) {
  const className = props.className ?? "size-4";
  switch (props.command) {
    case "undo":
      return <Undo2 className={className} />;
    case "redo":
      return <Redo2 className={className} />;
    case "bold":
      return <Bold className={className} strokeWidth={2.5} />;
    case "italic":
      return <Italic className={className} />;
    case "inlineCode":
      return <Code className={className} />;
    case "link":
      return <Link2 className={className} />;
    case "text":
      return <TextInitial className={className} />;
    case "quote":
      return <TextQuote className={className} />;
    case "bulletList":
      return <List className={className} />;
    case "numberedList":
      return <ListOrdered className={className} />;
    case "noList":
      return <ListX className={className} />;
    case "insert":
      return <Plus className={className} />;
  }
}
