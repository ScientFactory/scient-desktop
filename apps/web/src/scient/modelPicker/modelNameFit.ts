/** The narrowest truncated model name that still reads, a few letters and the ellipsis. */
const READABLE_MODEL_NAME_PX = 48;

/** On an icon wrapper only while it renders a provider icon. */
const ICON = "[data-model-trigger-icon]";
/** The model name, cost and effort; status text such as an update in progress never carries it. */
const TEXT = "[data-model-trigger-text]";
const NAME = `[data-chat-provider-model-picker-label="true"]${TEXT}`;
/** A status shown only while the name is hidden, which the text trigger does not take. */
const HIDDEN_STATUS = "[data-model-trigger-hidden-status]";
const TEXT_MIN_WIDTH = "--model-trigger-text-min-width";

/** Names the text trigger's minimum width, which the icon-only trigger drops but still measures. */
export const MODEL_TRIGGER_TEXT_MIN_WIDTH_CLASS_NAME =
  "[--model-trigger-text-min-width:--spacing(13)]";

/**
 * Leaves the provider icon and any status: the name, cost and effort stay laid out, out of flow,
 * so the composer can still measure the width they need. The trigger's aria-label keeps them.
 */
export const MODEL_NAME_HIDDEN_TRIGGER_CLASS_NAME =
  "min-w-0 [&_[data-model-trigger-text]]:pointer-events-none [&_[data-model-trigger-text]]:invisible [&_[data-model-trigger-text]]:absolute [&_[data-model-trigger-text]]:w-max";

interface ModelNameFit {
  /** Width the trigger gains once the hidden name, cost and effort show again beside the icon. */
  hiddenWidth: number;
  /** How far the name may truncate and still read; absent when nothing can replace it. */
  truncatableWidth: number | undefined;
}

function outerWidthWithGap(element: HTMLElement, gap: number): number {
  const style = getComputedStyle(element);
  return (
    element.getBoundingClientRect().width +
    gap +
    (Number.parseFloat(style.marginInlineStart) || 0) +
    (Number.parseFloat(style.marginInlineEnd) || 0)
  );
}

let textMinWidthRegistered = false;

/** The text trigger's minimum in px; registered as a length so the computed value resolves. */
function textMinWidth(picker: HTMLElement): number {
  if (!textMinWidthRegistered) {
    textMinWidthRegistered = true;
    try {
      CSS.registerProperty({
        name: TEXT_MIN_WIDTH,
        syntax: "<length>",
        inherits: false,
        initialValue: "0px",
      });
    } catch {
      // Already registered by an earlier module instance.
    }
  }
  return Number.parseFloat(getComputedStyle(picker).getPropertyValue(TEXT_MIN_WIDTH)) || 0;
}

function hiddenTextWidth(picker: HTMLElement): number {
  const elements = picker.querySelectorAll<HTMLElement>(TEXT);
  const gap = elements[0]
    ? Number.parseFloat(getComputedStyle(elements[0].parentElement!).columnGap) || 0
    : 0;
  let width = 0;
  for (const element of elements) width += outerWidthWithGap(element, gap);
  for (const status of picker.querySelectorAll<HTMLElement>(HIDDEN_STATUS)) {
    width -= outerWidthWithGap(status, gap);
  }
  // The text trigger never lays out narrower than its minimum, so neither may its reconstruction.
  return Math.max(width, textMinWidth(picker) - picker.getBoundingClientRect().width);
}

/**
 * A picker without a rendered provider icon, or one showing a status instead of the model name,
 * keeps truncating its text: hiding it would leave nothing readable.
 */
export function measureModelNameFit(picker: HTMLElement): ModelNameFit {
  const label = picker.querySelector<HTMLElement>(NAME);
  if (!label || !picker.querySelector(ICON)) return { hiddenWidth: 0, truncatableWidth: undefined };
  if (picker.dataset.modelNameHidden === "true") {
    // Out of flow, the label lays out at its natural width within its max width.
    const labelWidth = label.getBoundingClientRect().width;
    return {
      hiddenWidth: hiddenTextWidth(picker),
      truncatableWidth: Math.max(0, labelWidth - READABLE_MODEL_NAME_PX),
    };
  }
  const maxWidth = Number.parseFloat(getComputedStyle(label).maxWidth);
  const labelWidth = Math.min(
    label.scrollWidth,
    Number.isFinite(maxWidth) ? maxWidth : Number.POSITIVE_INFINITY,
  );
  return { hiddenWidth: 0, truncatableWidth: Math.max(0, labelWidth - READABLE_MODEL_NAME_PX) };
}
