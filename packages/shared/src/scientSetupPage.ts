// Page scripts the desktop runs in a person's own tab, in its isolated world, for Accounts.
import { loginFieldsKitSource } from "./scientLoginFields.ts";

/** Largest side a QR candidate is drawn at: 4 px or more per module for any setup code. */
const QR_SIDE = 240;
/** The pixels all candidates may send together, in base64 characters. */
const QR_PAYLOAD = 48_000;

/**
 * A 2FA setup page's `otpauth://` links and each square image, canvas or SVG as one bit per
 * pixel, as many as fit one budget (`AccountSetupPage`). Unreadable cross-origin images are left
 * out; an SVG is drawn from its own shapes, with no image load.
 */
export const setupPageScript = String.raw`(() => {
  const login = ${loginFieldsKitSource};
  const uris = new Set();
  for (const link of document.querySelectorAll('a[href^="otpauth:" i]')) uris.add(link.href.slice(0, 2048));
  for (const found of (document.body?.innerText ?? "").matchAll(/otpauth:\/\/totp\/[^\s"'<>]+/gi)) uris.add(found[0].slice(0, 2048));
  const square = (element) => {
    if (!login.visible(element)) return false;
    const box = element.getBoundingClientRect();
    return box.width >= 64 && box.width <= 1200 && Math.abs(box.width - box.height) <= 0.2 * box.width;
  };
  const images = [];
  let sent = 0;
  for (const element of Array.from(document.querySelectorAll("img, canvas, svg")).filter(square).slice(0, 6)) {
    try {
      const box = element.getBoundingClientRect();
      const natural = element instanceof HTMLImageElement ? [element.naturalWidth, element.naturalHeight]
        : element instanceof HTMLCanvasElement ? [element.width, element.height]
        : [box.width * 3, box.height * 3];
      if (!natural[0] || !natural[1]) continue;
      const scale = Math.min(1, ${QR_SIDE} / Math.max(natural[0], natural[1]));
      const width = Math.round(natural[0] * scale);
      const height = Math.round(natural[1] * scale);
      const pad = 16;
      const canvas = document.createElement("canvas");
      canvas.width = width + 2 * pad;
      canvas.height = height + 2 * pad;
      const context = canvas.getContext("2d");
      context.fillStyle = "#fff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.imageSmoothingEnabled = false;
      if (element instanceof SVGSVGElement) {
        const view = element.viewBox?.baseVal;
        const [x, y, w, h] = view && view.width ? [view.x, view.y, view.width, view.height] : [0, 0, box.width, box.height];
        const toUser = element.getScreenCTM()?.inverse();
        context.translate(pad, pad);
        context.scale(width / w, height / h);
        context.translate(-x, -y);
        for (const shape of element.querySelectorAll("rect, path, polygon")) {
          const fill = getComputedStyle(shape).fill;
          const own = shape.getScreenCTM();
          if (!fill || fill === "none" || !toUser || !own) continue;
          const m = toUser.multiply(own);
          context.save();
          context.transform(m.a, m.b, m.c, m.d, m.e, m.f);
          context.fillStyle = fill;
          if (shape instanceof SVGRectElement) context.fillRect(shape.x.baseVal.value, shape.y.baseVal.value, shape.width.baseVal.value, shape.height.baseVal.value);
          else if (shape instanceof SVGPathElement) context.fill(new Path2D(shape.getAttribute("d") ?? ""));
          else context.fill(new Path2D("M" + (shape.getAttribute("points") ?? "").trim() + "Z"));
          context.restore();
        }
      } else context.drawImage(element, pad, pad, width, height);
      const rgba = context.getImageData(0, 0, canvas.width, canvas.height).data;
      const count = canvas.width * canvas.height;
      const grey = new Uint8Array(count);
      let low = 255;
      let high = 0;
      for (let i = 0; i < count; i++) {
        grey[i] = (rgba[4 * i] * 299 + rgba[4 * i + 1] * 587 + rgba[4 * i + 2] * 114) / 1000;
        low = Math.min(low, grey[i]);
        high = Math.max(high, grey[i]);
      }
      const middle = (low + high) / 2;
      const packed = new Uint8Array(Math.ceil(count / 8));
      for (let i = 0; i < count; i++) if (grey[i] < middle) packed[i >> 3] |= 128 >> (i & 7);
      let binary = "";
      for (let i = 0; i < packed.length; i += 8192) binary += String.fromCharCode.apply(null, packed.subarray(i, i + 8192));
      const bits = btoa(binary);
      if (sent + bits.length > ${QR_PAYLOAD}) break;
      sent += bits.length;
      images.push({ width: canvas.width, height: canvas.height, bits });
    } catch {}
  }
  return { uris: [...uris].slice(0, 4), images };
})()`;

/** Links on one page tried for a change-password form, best first. */
export const PASSWORD_PAGE_LINKS = 4;

/**
 * The page as a Fix's walk sees it: whether it came back an error, whether it shows a
 * new-password form, and its same-origin links that may lead to one, best first (a change link,
 * then password, then security, then account or settings). Paths only: no query or fragment,
 * which can carry a session's tokens.
 */
export const passwordPageScript = `(() => {
  const ranks = [/change.?password|update.?password|new.?password/i, /password/i, /security/i, /account|setting|profile/i];
  const links = Array.from(document.querySelectorAll("a[href]")).flatMap((a) => {
    const url = URL.parse(a.href, location.href);
    if (!url || url.origin !== location.origin) return [];
    const words = [a.textContent, a.getAttribute("aria-label"), a.title, url.pathname].join(" ");
    const rank = ranks.findIndex((pattern) => pattern.test(words));
    return rank === -1 ? [] : [{ rank, href: url.origin + url.pathname }];
  });
  links.sort((a, b) => a.rank - b.rank);
  return {
    failed: (performance.getEntriesByType("navigation")[0]?.responseStatus ?? 0) >= 400,
    form: (${loginFieldsKitSource}).newPasswordBoxes(Array.from(document.querySelectorAll("input"))).length > 0,
    links: [...new Set(links.map((link) => link.href))].slice(0, ${PASSWORD_PAGE_LINKS}),
  };
})()`;
