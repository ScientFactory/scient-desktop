import { DEFAULT_BROWSER_PROFILE_ID } from "@t3tools/contracts";

import { ScientSymbol } from "~/components/ScientSymbol";
import { cn } from "~/lib/utils";

import { AccountLogo } from "./AccountLogo";
import { browserIconUrl, profilePresentation } from "./accountsView";

/**
 * A browser profile's picture from its source browser. Without one, Main shows the Scient symbol,
 * a profile from another browser that browser's mark, and any other its initial on its colour.
 */
export function ProfilePicture({
  name,
  picture,
  color,
  id,
  browser,
  size = "md",
}: {
  name: string;
  picture?: string | undefined;
  color?: string | undefined;
  id?: string | undefined;
  /** The browser the profile came from. */
  browser?: string | undefined;
  size?: "sm" | "md";
}) {
  const visual = profilePresentation({ picture, color });
  const frame = size === "sm" ? "size-5 text-[10px]" : "size-10 text-sm";
  const mark = browser ? browserIconUrl(browser) : undefined;
  if (visual.picture)
    return (
      <img
        alt=""
        src={visual.picture}
        className={cn("shrink-0 rounded-full object-cover", frame)}
      />
    );
  if (id === DEFAULT_BROWSER_PROFILE_ID)
    return (
      <span
        aria-hidden
        className={cn("flex shrink-0 items-center justify-center rounded-full border", frame)}
      >
        <ScientSymbol className="size-3/5" />
      </span>
    );
  if (mark) return <AccountLogo src={mark} className={cn("rounded-[25%]", frame)} />;
  return (
    <span
      aria-hidden
      className={cn(
        "flex shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary",
        frame,
      )}
      style={
        visual.color
          ? {
              backgroundColor: `color-mix(in srgb, ${visual.color} 20%, var(--background))`,
              color: "var(--foreground)",
            }
          : undefined
      }
    >
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}
