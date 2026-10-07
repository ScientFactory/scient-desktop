import type { MathSymbolIllustration as Illustration } from "./mathSymbolIllustrations";

/** Layout diagrams use the same stroke and current-color treatment as Scient icons. */
export function MathSymbolIllustration({ illustration }: { illustration: Illustration }) {
  return (
    <svg
      className="scient-latex-symbol-illustration"
      viewBox="0 0 36 36"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {illustration.kind === "spacing" &&
        (() => {
          const left = 18 - illustration.width / 2;
          const right = 18 + illustration.width / 2;
          return (
            <>
              <path d={`M${left} 10v16M${right} 10v16`} strokeDasharray="2 3" opacity=".5" />
              <path d={`M${left} 18h${illustration.width}`} />
              <path
                d={
                  illustration.negative
                    ? `M${left} 15l3 3-3 3M${right} 15l-3 3 3 3`
                    : `M${left + 3} 15l-3 3 3 3M${right - 3} 15l3 3-3 3`
                }
              />
            </>
          );
        })()}
      {illustration.kind === "phantom" && (
        <>
          <rect x="9" y="9" width="18" height="18" rx="2" strokeDasharray="2 3" opacity=".6" />
          {illustration.axis !== "vertical" && <path d="M5 31h26M8 28l-3 3 3 3M28 28l3 3-3 3" />}
          {illustration.axis !== "horizontal" && <path d="M4 6v22M1 9l3-3 3 3M1 25l3 3 3-3" />}
        </>
      )}
      {illustration.kind === "smash" && (
        <>
          <path d="M7 19h22M13 11l8 14M21 11l-8 14" />
          {illustration.side !== "bottom" && <path d="M18 3v7m-3-3 3 3 3-3" />}
          {illustration.side !== "top" && <path d="M18 33V23m-3 3 3-3 3 3" />}
          <path d="M9 12v14h18V12" strokeDasharray="2 3" opacity=".4" />
        </>
      )}
      {illustration.kind === "overlap" && (
        <>
          <path d="M18 5v26M3 28h30" strokeDasharray="2 3" opacity=".5" />
          <rect
            x={illustration.align === "left" ? 4 : illustration.align === "right" ? 18 : 11}
            y="10"
            width="14"
            height="14"
            rx="2"
          />
          <circle cx="18" cy="28" r="1.5" fill="currentColor" stroke="none" />
        </>
      )}
    </svg>
  );
}
