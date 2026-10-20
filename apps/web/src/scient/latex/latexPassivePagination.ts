/** Printed macro text and generated lists keep one source owner across page cuts. */
export interface PassiveBoundary {
  readonly owner: number;
  readonly kind: string;
  readonly path: readonly number[];
  readonly offset: number;
}

export function passiveBoundary(
  root: Element,
  target: globalThis.Node,
  offset: number,
  owner: number,
): PassiveBoundary | undefined {
  const path: number[] = [];
  let child = target;
  while (child !== root) {
    const parent = child.parentNode;
    if (!parent) return undefined;
    path.unshift([...parent.childNodes].indexOf(child as ChildNode));
    child = parent;
  }
  return { owner, kind: root.getAttribute("data-paged-passive-root")!, path, offset };
}

/** Only passive DOM is changed; source tokens and ProseMirror offsets stay intact. */
export function applyPassivePageGaps(
  element: HTMLElement,
  gaps: readonly { boundary: PassiveBoundary; height: number }[],
) {
  const old = [...element.querySelectorAll<HTMLElement>('[data-paged-repeat="passive"]')];
  const signature = JSON.stringify(gaps);
  if (element.dataset.passivePageGaps === signature && old.length === gaps.length) return;
  for (const gap of old) gap.remove();
  for (const root of element.querySelectorAll("[data-paged-passive-root]")) root.normalize();
  const targets = gaps.flatMap(({ boundary, height }) => {
    const root = element.querySelector(`[data-paged-passive-root="${boundary.kind}"]`);
    if (!root) return [];
    let target: globalThis.Node = root;
    for (const index of boundary.path) {
      const next = target.childNodes[index];
      if (!next) return [];
      target = next;
    }
    return [{ target, offset: boundary.offset, height }];
  });
  // Later cuts cannot disturb the paths and text offsets of preceding cuts.
  for (const { target, offset, height } of targets.reverse()) {
    const marker = element.ownerDocument.createElement("span");
    marker.dataset.pagedRepeat = "passive";
    marker.setAttribute("aria-hidden", "true");
    marker.style.cssText = `display:block;height:${height}px;pointer-events:none;`;
    if (target.nodeType === Node.TEXT_NODE) {
      const tail = (target as Text).splitText(Math.min(offset, target.textContent?.length ?? 0));
      tail.parentNode?.insertBefore(marker, tail);
    } else target.insertBefore(marker, target.childNodes[offset] ?? null);
  }
  element.dataset.passivePageGaps = signature;
}
