import article from "./previews/article.png";
import blank from "./previews/blank.png";
import cv from "./previews/cv.png";
import grantProposal from "./previews/grant-proposal.png";
import labReport from "./previews/lab-report.png";
import lectureNotes from "./previews/lecture-notes.png";
import letter from "./previews/letter.png";
import problemSet from "./previews/problem-set.png";
import responseToReviewers from "./previews/response-to-reviewers.png";
import thesis from "./previews/thesis.png";

/**
 * The first page of each built-in template, typeset. Rendered by
 * scripts/render-template-previews.ts; run it again after changing a template.
 */
const BUILT_IN_PREVIEWS: Readonly<Record<string, string>> = {
  article,
  blank,
  cv,
  "grant-proposal": grantProposal,
  "lab-report": labReport,
  "lecture-notes": lectureNotes,
  letter,
  "problem-set": problemSet,
  "response-to-reviewers": responseToReviewers,
  thesis,
};

/** A template copied from a built-in one shows that one's page until it is updated. */
const BUILT_IN_REFERENCE = "builtin:";

export function builtInPreviewReference(id: string): string | null {
  return BUILT_IN_PREVIEWS[id] ? `${BUILT_IN_REFERENCE}${id}` : null;
}

/** A template's picture: an image, or a page as Visual drew it. */
export type TemplatePicture =
  | { readonly kind: "image"; readonly src: string }
  | {
      readonly kind: "page";
      readonly html: string;
      readonly width: number;
      readonly height: number;
    };

/** The picture for a built-in template, or for a stored preview of the person's own. */
export function templatePicture(
  builtInId: string | null,
  stored: string | null,
): TemplatePicture | null {
  if (builtInId !== null) {
    const src = BUILT_IN_PREVIEWS[builtInId];
    return src ? { kind: "image", src } : null;
  }
  if (!stored) return null;
  if (stored.startsWith(BUILT_IN_REFERENCE))
    return templatePicture(stored.slice(BUILT_IN_REFERENCE.length), null);
  const page = parsePage(stored);
  return page ? { kind: "page", ...page } : null;
}

/** Elements a page picture never keeps: nothing that runs, loads or embeds. */
const DROPPED =
  "script, style, link, meta, iframe, frame, object, embed, base, form, audio, video, source, animate, animateMotion, animateTransform, set";

/**
 * A page picture made safe to show: no element that runs or loads anything, no
 * event handler, no script URL, nothing editable or focusable, and no ids to
 * collide with the page around it.
 */
export function sanitizePage(root: Element): void {
  for (const element of root.querySelectorAll(DROPPED)) element.remove();
  for (const element of [root, ...root.querySelectorAll("*")]) {
    // A copy: removing an attribute changes the live list.
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      const value = attribute.value.trim().toLowerCase();
      if (
        name.startsWith("on") ||
        name === "id" ||
        name === "contenteditable" ||
        name === "tabindex" ||
        name === "autofocus" ||
        name === "srcdoc" ||
        name === "srcset" ||
        name === "poster" ||
        name === "background" ||
        (name === "style" && /url\s*\(|@import/iu.test(attribute.value)) ||
        (name === "src" &&
          !(
            element.tagName.toLowerCase() === "img" &&
            /^data:image\/(?:png|jpeg|webp);base64,/iu.test(attribute.value)
          )) ||
        ((name === "href" || name === "xlink:href") && !value.startsWith("#")) ||
        ((name === "href" || name === "src" || name === "xlink:href" || name === "action") &&
          (value.startsWith("javascript:") || value.startsWith("data:text/html")))
      )
        element.removeAttribute(attribute.name);
    }
  }
}

function parsePage(stored: string): { html: string; width: number; height: number } | null {
  const document = new DOMParser().parseFromString(stored, "text/html");
  const root = document.body.firstElementChild;
  if (!root || root.tagName.toLowerCase() !== "div") return null;
  const width = Number(root.getAttribute("data-page-width"));
  const height = Number(root.getAttribute("data-page-height"));
  if (!(Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0)) return null;
  sanitizePage(root);
  return { html: root.outerHTML, width, height };
}

/**
 * The first page of the LaTeX document on screen, as Visual draws it, without
 * the new document's own controls; null when no Visual page is showing.
 */
export function captureVisualPage(): string | null {
  const paper = [...document.querySelectorAll<HTMLElement>(".scient-latex-visual-paper")].find(
    (candidate) => candidate.getClientRects().length > 0,
  );
  if (!paper) return null;
  const stage = paper.closest<HTMLElement>(".scient-latex-page-stage") ?? paper;
  const width = stage.offsetWidth;
  const declared = parseFloat(
    getComputedStyle(stage).getPropertyValue("--scient-latex-paper-height"),
  );
  const height = declared > 0 ? declared : Math.round(width * Math.SQRT2);
  if (!(width > 0)) return null;
  const clone = stage.cloneNode(true) as HTMLElement;
  clone.style.transform = "none";
  // Persist figure pixels, never signed URLs that expire after the current session.
  const images = [...stage.querySelectorAll<HTMLImageElement>("img")];
  [...clone.querySelectorAll<HTMLImageElement>("img")].forEach((copy, index) => {
    const image = images[index];
    copy.removeAttribute("src");
    copy.removeAttribute("srcset");
    if (!image?.complete || image.naturalWidth <= 0 || image.naturalHeight <= 0) return;
    const canvas = document.createElement("canvas");
    const scale = Math.min(1, 600 / image.naturalWidth, 600 / image.naturalHeight);
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    try {
      const context = canvas.getContext("2d");
      if (!context) return;
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      copy.src = canvas.toDataURL("image/png");
    } catch {
      // An unreadable cross-origin figure leaves its caption, not an expiring URL.
    }
  });
  // A field is drawn as its text: what was typed, or its placeholder, faint.
  const fields = [
    ...stage.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("textarea, input"),
  ];
  [...clone.querySelectorAll("textarea, input")].forEach((copy, index) => {
    const field = fields[index];
    const text = document.createElement("div");
    text.className = copy.className;
    const style = copy.getAttribute("style");
    if (style) text.setAttribute("style", style);
    if (field) {
      // The field's own look comes from rules that name the field; keep it inline.
      const look = getComputedStyle(field);
      text.style.font = look.font;
      text.style.textAlign = look.textAlign;
      text.style.letterSpacing = look.letterSpacing;
      text.style.color = look.color;
    }
    if (field?.value) text.textContent = field.value;
    else {
      text.textContent = field?.placeholder ?? "";
      text.style.opacity = "0.4";
    }
    text.style.whiteSpace = "pre-wrap";
    copy.replaceWith(text);
  });
  for (const own of clone.querySelectorAll("[data-new-document-strip]")) own.remove();
  // Only what reaches the first page: later blocks would only weigh the picture down.
  const scale = paper.getBoundingClientRect().width / (paper.offsetWidth || 1);
  const top = paper.getBoundingClientRect().top;
  const blocks = paper.querySelector(".tiptap");
  const copies = clone.querySelector(".tiptap");
  if (blocks && copies) {
    const originals = [...blocks.children];
    [...copies.children].forEach((copy, index) => {
      const original = originals[index];
      if (original && (original.getBoundingClientRect().top - top) / scale > height) copy.remove();
    });
  }
  sanitizePage(clone);
  const wrapper = document.createElement("div");
  wrapper.setAttribute("data-page-width", String(width));
  wrapper.setAttribute("data-page-height", String(height));
  wrapper.append(clone);
  return wrapper.outerHTML;
}
