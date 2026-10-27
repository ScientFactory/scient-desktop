import { cn } from "~/lib/utils";

/** Logos in accountIcons.json are square tiles, so the frame alone gives them their shape. */
export function AccountLogo({
  src,
  className,
}: {
  readonly src: string;
  readonly className: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "flex shrink-0 overflow-hidden border [color-scheme:light] dark:border-white/10",
        className,
      )}
    >
      <img alt="" src={src} className="size-full object-cover" />
    </span>
  );
}
