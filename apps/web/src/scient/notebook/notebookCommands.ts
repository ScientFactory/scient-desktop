/** Jupyter's command mode: keys act on the selected cell while no editor has focus. */
export type NotebookCommand =
  | "edit"
  | "previous"
  | "next"
  | "insert-above"
  | "insert-below"
  | "delete"
  | "undo-delete"
  | "to-text"
  | "to-code"
  | "run"
  | "run-and-next"
  | "interrupt";

export interface NotebookKeyPress {
  readonly key: string;
  readonly at: number;
}

const DOUBLE_PRESS_MS = 600;

const SINGLE_KEYS: Readonly<Record<string, NotebookCommand>> = {
  Enter: "edit",
  ArrowUp: "previous",
  k: "previous",
  ArrowDown: "next",
  j: "next",
  a: "insert-above",
  b: "insert-below",
  z: "undo-delete",
  m: "to-text",
  y: "to-code",
};

export function notebookCommand(
  press: {
    readonly key: string;
    readonly shiftKey: boolean;
    readonly metaKey: boolean;
    readonly ctrlKey: boolean;
    readonly altKey: boolean;
  },
  previous: NotebookKeyPress | null,
  now: number,
): NotebookCommand | null {
  if (press.altKey) return null;
  if (press.key === "Enter" && press.shiftKey) return "run-and-next";
  if (press.key === "Enter" && (press.metaKey || press.ctrlKey)) return "run";
  if (press.shiftKey || press.metaKey || press.ctrlKey) return null;
  const repeated =
    previous !== null && previous.key === press.key && now - previous.at < DOUBLE_PRESS_MS;
  if (press.key === "d") return repeated ? "delete" : null;
  if (press.key === "i") return repeated ? "interrupt" : null;
  return SINGLE_KEYS[press.key] ?? null;
}
