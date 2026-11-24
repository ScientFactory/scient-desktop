import { create } from "zustand";

type CaptureUi = { open: boolean; projectId: string; setOpen: (open: boolean) => void };
export const useCaptureUi = create<CaptureUi>((set) => ({
  open: false,
  projectId: "",
  setOpen: (open) => set({ open }),
}));

export function openRecordingCapture(projectId = "") {
  const ui = useCaptureUi.getState();
  useCaptureUi.setState({ open: true, projectId: ui.open ? ui.projectId : projectId });
}
