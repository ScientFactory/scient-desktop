export const SETTINGS_SOURCE_RISE = 12;

/** One closed path; the decorative cue never changes the design-token card corners. */
export function settingsSourceOutline(
  width: number,
  height: number,
  radius: number,
  center: number | null,
): string | null {
  if (![width, height, radius].every(Number.isFinite) || width < 2 || height < 2 || radius < 0)
    return null;
  // Half-pixel inset keeps the one-pixel outline inside its measured bounds.
  const left = 0.5;
  const right = width - 0.5;
  const top = SETTINGS_SOURCE_RISE + 0.5;
  const bottom = height + SETTINGS_SOURCE_RISE - 0.5;
  const cardRadius = Math.min(radius, (right - left) / 2, (bottom - top) / 2);
  const cueRadius = 6;
  const half = Math.min(32, (right - left) / 2 - cardRadius - cueRadius);
  const raised =
    center !== null && Number.isFinite(center) && center >= 0 && center <= width && half >= 6;
  const middle = raised
    ? Math.max(
        left + cardRadius + cueRadius + half,
        Math.min(right - cardRadius - cueRadius - half, center),
      )
    : 0;
  const cueLeft = middle - half;
  const cueRight = middle + half;
  const cue = raised
    ? `H ${cueLeft - cueRadius} Q ${cueLeft} ${top} ${cueLeft} ${top - cueRadius} Q ${cueLeft} 0.5 ${cueLeft + cueRadius} 0.5 H ${cueRight - cueRadius} Q ${cueRight} 0.5 ${cueRight} ${top - cueRadius} Q ${cueRight} ${top} ${cueRight + cueRadius} ${top}`
    : "";
  return `M ${left + cardRadius} ${top} ${cue} H ${right - cardRadius} A ${cardRadius} ${cardRadius} 0 0 1 ${right} ${top + cardRadius} V ${bottom - cardRadius} A ${cardRadius} ${cardRadius} 0 0 1 ${right - cardRadius} ${bottom} H ${left + cardRadius} A ${cardRadius} ${cardRadius} 0 0 1 ${left} ${bottom - cardRadius} V ${top + cardRadius} A ${cardRadius} ${cardRadius} 0 0 1 ${left + cardRadius} ${top} Z`;
}
