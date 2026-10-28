import { KeyRoundIcon } from "lucide-react";
import { useState } from "react";

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

/**
 * A site's own favicon, then its parent domain's, else the key. Loaded from the site itself, never a
 * third-party icon service, so the list of the user's sites stays private; only rows on screen load.
 */
export function SiteFavicon({ site }: { readonly site: string }) {
  const labels = site.split(".");
  const candidates = [site, ...(labels.length > 2 ? [labels.slice(1).join(".")] : [])].map(
    (host) => `https://${host}/favicon.ico`,
  );
  const [failed, setFailed] = useState(0);
  const src = candidates[failed];
  return (
    <span className="flex size-10 shrink-0 items-center justify-center rounded-[25%] bg-muted">
      {src ? (
        <img
          key={src}
          alt=""
          src={src}
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          className="size-5 object-contain"
          onError={() => setFailed(failed + 1)}
        />
      ) : (
        <KeyRoundIcon className="size-4 text-muted-foreground" />
      )}
    </span>
  );
}
