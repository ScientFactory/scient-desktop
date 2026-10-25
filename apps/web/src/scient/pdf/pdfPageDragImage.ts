// The browser's own drag image is a still picture, so it is replaced by a blank one and
// these cards follow the pointer instead.
const BLANK_DRAG_IMAGE =
  typeof Image === "undefined"
    ? null
    : Object.assign(new Image(), {
        src: "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
      });
const CARD_WIDTH = 104;
// Cards behind the grabbed one: how far each sits from it and how it leans.
const STACK = [
  { x: 0, y: 0, rotate: 0 },
  { x: 10, y: -2, rotate: 6 },
  { x: -8, y: 8, rotate: -6 },
  { x: 16, y: 4, rotate: 10 },
];

let stopFollow: (() => void) | null = null;

/**
 * Lifts copies of the dragged pages out of the sidebar. Each starts where its page is and
 * glides to the pointer, the grabbed page first and the others trailing behind it, until
 * they sit as one stack under the pointer; the stack then follows the pointer. `grabbed`
 * is listed first in `canvases`. `onActive` is told once the cards are up and again when
 * the drag ends, dropped anywhere or cancelled.
 */
export function startPdfPageDragFollow(input: {
  readonly transfer: DataTransfer;
  readonly canvases: readonly HTMLCanvasElement[];
  readonly count: number;
  readonly pointer: { readonly x: number; readonly y: number };
  readonly onActive?: (active: boolean) => void;
}) {
  stopFollow?.();
  const grabbed = input.canvases[0];
  if (!grabbed || !BLANK_DRAG_IMAGE) return;
  input.transfer.setDragImage(BLANK_DRAG_IMAGE, 0, 0);

  const layer = document.createElement("div");
  layer.className = "scient-pdf-page-drag-layer";
  layer.setAttribute("aria-hidden", "true");
  const cards = input.canvases.slice(0, STACK.length).map((source, index) => {
    const bounds = source.getBoundingClientRect();
    const card = document.createElement("div");
    card.className = "scient-pdf-page-drag-card";
    card.style.zIndex = String(STACK.length - index);
    // The trailing cards take longer, so they catch up with the grabbed one.
    card.style.transitionDuration = `${index === 0 ? 90 : 200 + index * 70}ms`;
    const canvas = document.createElement("canvas");
    canvas.width = source.width;
    canvas.height = source.height;
    if (source.width && source.height) canvas.getContext("2d")?.drawImage(source, 0, 0);
    card.append(canvas);
    card.style.width = `${bounds.width}px`;
    card.style.transform = `translate(${bounds.left}px, ${bounds.top}px)`;
    layer.append(card);
    return { card, bounds, shrink: CARD_WIDTH / Math.max(1, bounds.width) };
  });
  // Keep the point that was grabbed under the pointer.
  const lead = cards[0]!;
  const hold = {
    x: (input.pointer.x - lead.bounds.left) * lead.shrink,
    y: (input.pointer.y - lead.bounds.top) * lead.shrink,
  };
  if (input.count > 1) {
    const badge = document.createElement("span");
    badge.className = "scient-pdf-page-drag-count";
    badge.textContent = `${input.count} pages`;
    lead.card.append(badge);
  }
  document.body.append(layer);

  let frame = 0,
    x = input.pointer.x,
    y = input.pointer.y;
  const place = () => {
    frame = 0;
    cards.forEach(({ card, shrink }, index) => {
      const offset = STACK[index]!;
      card.style.transform = `translate(${x - hold.x + offset.x}px, ${y - hold.y + offset.y}px) rotate(${offset.rotate}deg) scale(${shrink})`;
    });
  };
  const track = (event: DragEvent) => {
    // Some platforms report 0,0 on the last event of a drag.
    if (!event.clientX && !event.clientY) return;
    x = event.clientX;
    y = event.clientY;
    if (!frame) frame = requestAnimationFrame(place);
  };
  // Starting from the pages' own places, so the move to the pointer is animated.
  frame = requestAnimationFrame(() => {
    input.onActive?.(true);
    frame = requestAnimationFrame(place);
  });
  const stop = () => {
    cancelAnimationFrame(frame);
    document.removeEventListener("dragover", track, true);
    document.removeEventListener("drop", stop, true);
    document.removeEventListener("dragend", stop, true);
    layer.remove();
    if (stopFollow === stop) stopFollow = null;
    input.onActive?.(false);
  };
  document.addEventListener("dragover", track, true);
  document.addEventListener("drop", stop, true);
  document.addEventListener("dragend", stop, true);
  stopFollow = stop;
}
