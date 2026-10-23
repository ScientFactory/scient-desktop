import type { ContextMenuItem, KeepAwakeChoice } from "@t3tools/contracts";

export type KeepAwakeMenuId = "keep-awake" | `keep-awake:${KeepAwakeChoice}`;
export interface KeepAwakeMenuState {
  readonly choice: KeepAwakeChoice;
  readonly status: "off" | "idle" | "awake" | "paused" | "unknown" | undefined;
  readonly available: boolean;
}
export function keepAwakeMenu(
  state: KeepAwakeMenuState | undefined,
): ContextMenuItem<KeepAwakeMenuId>[] {
  if (state === undefined) return [];
  const status =
    !state.available || state.status === "unknown"
      ? "unavailable"
      : state.status === "awake"
        ? "requested"
        : state.status === "paused"
          ? "paused"
          : undefined;
  return [
    {
      id: "keep-awake",
      label: `Keep computer awake${status ? ` (${status})` : ""}`,
      children: [
        {
          id: "keep-awake:app",
          label: "Use app setting",
          checked: state.choice === "app",
          disabled: !state.available,
        },
        {
          id: "keep-awake:once",
          label: "Until work finishes",
          checked: state.choice === "once",
          disabled: !state.available,
        },
      ],
    },
  ];
}
