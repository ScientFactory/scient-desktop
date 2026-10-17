import {
  BookOpenIcon,
  CircleXIcon,
  CloudIcon,
  FolderOpenIcon,
  ImageIcon,
  LayersIcon,
  MousePointerClickIcon,
  PencilIcon,
  ShieldCheckIcon,
  SquareMousePointerIcon,
} from "lucide-react";
import type { ReactElement } from "react";

import { ScientTraceSymbol } from "./ScientTraceSymbol";
import { SquareTerminalLowered, type TraceIconOverride } from "./traceIcons";

/** Icon names only Scient draws: the per-action overrides and Scient's mark. */
export type ScientTraceIconName = TraceIconOverride | "scient";

type TraceIconRenderer = (className: string) => ReactElement;

/**
 * Scient's trace icon set. Each name here is drawn with Scient's icon, ahead of
 * the shared icon switch: Cloud for thinking, BookOpen for reading, Pencil for
 * editing, the lowered terminal, CircleX for failures, SquareMousePointer for
 * the browser, Scient's mark, and the per-action overrides.
 */
const SCIENT_TRACE_ICONS: Readonly<Record<string, TraceIconRenderer>> = {
  brain: (className) => <CloudIcon className={className} aria-hidden />,
  browser: (className) => <SquareMousePointerIcon className={className} aria-hidden />,
  computer: (className) => <MousePointerClickIcon className={className} aria-hidden />,
  "t3-code": (className) => <ScientTraceSymbol className={className} />,
  scient: (className) => <ScientTraceSymbol className={className} />,
  eye: (className) => <BookOpenIcon className={className} aria-hidden />,
  folder: (className) => <FolderOpenIcon className={className} aria-hidden />,
  image: (className) => <ImageIcon className={className} aria-hidden />,
  shield: (className) => <ShieldCheckIcon className={className} aria-hidden />,
  skill: (className) => <LayersIcon className={className} aria-hidden />,
  "square-pen": (className) => <PencilIcon className={className} aria-hidden />,
  terminal: (className) => <SquareTerminalLowered className={className} aria-hidden />,
  x: (className) => <CircleXIcon className={className} aria-hidden />,
};

/** The icon Scient draws for a trace icon name, or null to keep the shared one. */
export function scientTraceIcon(name: string, className: string): ReactElement | null {
  return Object.hasOwn(SCIENT_TRACE_ICONS, name) ? SCIENT_TRACE_ICONS[name]!(className) : null;
}
