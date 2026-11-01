import type { ContextMenuItem } from "@t3tools/contracts";

export type KeepAwakeMenuId = "keep-awake";

export function keepAwakeMenu(chosen: boolean | undefined): ContextMenuItem<KeepAwakeMenuId>[] {
  return chosen === undefined
    ? []
    : [{ id: "keep-awake", label: "Keep computer awake until done", checked: chosen }];
}
