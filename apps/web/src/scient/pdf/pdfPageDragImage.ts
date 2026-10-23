export function setPdfPageDragImage(
  transfer: DataTransfer,
  thumbnail: HTMLCanvasElement,
  count: number,
) {
  const preview = document.createElement("div");
  preview.className = "scient-pdf-page-drag-preview";
  preview.setAttribute("aria-hidden", "true");
  const bounds = thumbnail.getBoundingClientRect();
  preview.style.left = `${Math.max(0, Math.min(bounds.left, window.innerWidth - 116))}px`;
  preview.style.top = `${Math.max(0, Math.min(bounds.top, window.innerHeight - 180))}px`;
  const card = document.createElement("div");
  card.className = "scient-pdf-page-drag-card";
  const canvas = document.createElement("canvas");
  canvas.width = thumbnail.width;
  canvas.height = thumbnail.height;
  if (thumbnail.width && thumbnail.height) canvas.getContext("2d")?.drawImage(thumbnail, 0, 0);
  card.append(canvas);
  const badge = document.createElement("span");
  badge.className = "scient-pdf-page-drag-count";
  badge.textContent = `${count} pages`;
  preview.append(card, badge);
  document.body.append(preview);
  transfer.setDragImage(preview, 22, 22);
  // Chromium captures the drag bitmap after dragstart, before the next task.
  window.setTimeout(() => preview.remove(), 0);
}
