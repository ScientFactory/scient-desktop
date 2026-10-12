/** Measure field text in screen coordinates, including wrapping, scrolling and RTL. */
export function latexTextSelectionRects(
  field: HTMLTextAreaElement | HTMLInputElement,
  from: number,
  to: number,
): DOMRect[] {
  if (from === to) return [];
  const document = field.ownerDocument;
  const rect = field.getBoundingClientRect(),
    style = getComputedStyle(field);
  const border = parseFloat(style.borderLeftWidth) + parseFloat(style.borderRightWidth);
  const padding = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
  const layoutWidth =
    parseFloat(style.width) + (style.boxSizing === "border-box" ? 0 : border + padding);
  // offsetWidth rounds away fractional field widths, enough to wrap a fitted
  // title or caption differently at document zoom.
  const scale = layoutWidth > 0 ? rect.width / layoutWidth : 1;
  const scrollbar = Math.max(0, field.offsetWidth - field.clientWidth - border);
  const mirror = document.createElement("div");
  for (const property of [
    "fontFamily",
    "fontWeight",
    "fontStyle",
    "fontVariant",
    "direction",
    "unicodeBidi",
    "textAlign",
    "textWrapMode",
    "textWrapStyle",
    "wordBreak",
    "tabSize",
  ] as const)
    mirror.style[property] = style[property];
  for (const property of [
    "fontSize",
    "letterSpacing",
    "paddingTop",
    "paddingRight",
    "paddingBottom",
    "paddingLeft",
  ] as const)
    mirror.style[property] = `${parseFloat(style[property]) * scale || 0}px`;
  mirror.style.lineHeight =
    style.lineHeight === "normal" ? "normal" : `${parseFloat(style.lineHeight) * scale}px`;
  Object.assign(mirror.style, {
    position: "fixed",
    left: `${rect.left - field.scrollLeft * scale}px`,
    top: `${rect.top - field.scrollTop * scale}px`,
    width: `${(layoutWidth - border - scrollbar) * scale}px`,
    boxSizing: "border-box",
    whiteSpace: style.whiteSpace,
    overflowWrap: style.overflowWrap,
    visibility: "hidden",
    pointerEvents: "none",
  });
  const text = document.createTextNode(field.value);
  mirror.append(text);
  document.body.append(mirror);
  try {
    const range = document.createRange();
    range.setStart(text, Math.min(from, field.value.length));
    range.setEnd(text, Math.min(to, field.value.length));
    return [...range.getClientRects()].flatMap((part) => {
      const left = Math.max(rect.left, part.left),
        right = Math.min(rect.right, part.right);
      const top = Math.max(rect.top, part.top),
        bottom = Math.min(rect.bottom, part.bottom);
      return right > left && bottom > top
        ? [new DOMRect(left, top, right - left, bottom - top)]
        : [];
    });
  } finally {
    mirror.remove();
  }
}
