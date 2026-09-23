// The composer skill chip uses em metrics so it scales with the prompt font size.
const INLINE_CHIP_GEOMETRY_CLASS_NAME =
  "inline-flex h-[1.41em] max-w-full items-center gap-[0.33em] rounded-[0.5em] px-[0.5em] font-medium leading-none align-middle";

const CONTEXT_INLINE_CHIP_TONE_CLASS_NAME =
  "border-[color-mix(in_oklab,var(--context-chip-accent)_34%,var(--contrast-border))] bg-[color-mix(in_oklab,var(--context-chip-accent)_11%,transparent)] text-[color-mix(in_oklab,var(--context-chip-accent)_22%,var(--contrast-foreground))]";

export const COMPOSER_INLINE_CHIP_DECORATOR_CLASS_NAME =
  "relative inline-flex items-center align-middle leading-none data-[composer-chip-selected]:after:pointer-events-none data-[composer-chip-selected]:after:absolute data-[composer-chip-selected]:after:inset-0 data-[composer-chip-selected]:after:rounded-[6px] data-[composer-chip-selected]:after:bg-[Highlight] data-[composer-chip-selected]:after:opacity-30 data-[composer-chip-selected]:after:content-['']";

export const COMPOSER_INLINE_CHIP_ICON_CLASS_NAME =
  "block size-[1.17em] shrink-0 self-center [&>svg]:block";

export const COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME =
  "block self-center truncate leading-tight select-none";

export const COMPOSER_INLINE_SKILL_CHIP_CLASS_NAME = `${INLINE_CHIP_GEOMETRY_CLASS_NAME} select-none border text-[0.86em] ${CONTEXT_INLINE_CHIP_TONE_CLASS_NAME} [--context-chip-accent:oklch(0.62_0.16_322)]`;
export const SKILL_CHIP_ICON_SVG = `<svg width="100%" height="100%" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/></svg>`;

/** Keeps both the recognizable beginning and the extension/end of a long attachment name. */
export function middleTruncateAttachmentName(name: string, maxCharacters = 36): string {
  const characters = Array.from(name);
  if (characters.length <= maxCharacters) return name;
  if (maxCharacters <= 0) return "";
  if (maxCharacters === 1) return "…";
  const available = maxCharacters - 1;
  const suffixLength = Math.min(available - 1, available >= 18 ? 14 : Math.ceil(available / 2));
  const prefixLength = available - suffixLength;
  const suffix = suffixLength === 0 ? "" : characters.slice(-suffixLength).join("");
  return `${characters.slice(0, prefixLength).join("")}…${suffix}`;
}
