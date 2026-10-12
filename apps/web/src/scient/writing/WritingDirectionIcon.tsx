/** Mirrored prose lines for the explicit LTR and RTL writing controls. */
export function WritingDirectionIcon({ direction }: { readonly direction: "ltr" | "rtl" }) {
  return (
    <svg
      aria-hidden="true"
      className="size-3.5 shrink-0 text-muted-foreground"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
    >
      <path d={direction === "rtl" ? "M1 3h14M5 8h10M9 13h6" : "M1 3h14M1 8h10M1 13h6"} />
    </svg>
  );
}
