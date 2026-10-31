import { cn } from "~/lib/utils";

import { profilePresentation } from "./accountsView";

/** A browser profile's picture from its source browser, else its initial on its colour; round, like a person. */
export function ProfilePicture({
  name,
  picture,
  color,
  size = "md",
}: {
  name: string;
  picture?: string | undefined;
  color?: string | undefined;
  size?: "sm" | "md";
}) {
  const visual = profilePresentation({ picture, color });
  const frame = size === "sm" ? "size-5 text-[10px]" : "size-10 text-sm";
  return visual.picture ? (
    <img alt="" src={visual.picture} className={cn("shrink-0 rounded-full object-cover", frame)} />
  ) : (
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
