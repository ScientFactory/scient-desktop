import { KeyRoundIcon } from "lucide-react";
import { useEffect, useEffectEvent, useState } from "react";

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

/** One desktop lookup per site for the whole session, shared by every row that shows it. */
const desktopIcons = new Map<string, Promise<string | null>>();

/**
 * The site's icon, else the key. The desktop reads it from the site's own page and caches it; a
 * web client tries the site's favicon.ico. Never a third-party icon service, so the list of the
 * user's sites stays private.
 */
export function SiteFavicon({ site }: { readonly site: string }) {
  const siteIcon = window.desktopBridge?.accounts?.siteIcon;
  const [desktopIcon, setDesktopIcon] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const lookUp = useEffectEvent((site: string) => {
    if (!siteIcon) return undefined;
    let request = desktopIcons.get(site);
    if (!request) {
      request = siteIcon(site).catch(() => null);
      desktopIcons.set(site, request);
    }
    return request;
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Ask the desktop for this site's cached icon when its row appears.
  useEffect(() => {
    let live = true;
    void lookUp(site)?.then((icon) => {
      if (live) setDesktopIcon(icon);
    });
    return () => {
      live = false;
    };
  }, [site]);
  const src = siteIcon ? desktopIcon : failed ? null : `https://${site}/favicon.ico`;
  return (
    <span className="flex size-10 shrink-0 items-center justify-center rounded-[25%] bg-muted">
      {src ? (
        <img
          key={src}
          alt=""
          src={src}
          // Desktop icons arrive as data; only a site's own favicon.ico waits for its row to show.
          loading={siteIcon ? "eager" : "lazy"}
          decoding="async"
          referrerPolicy="no-referrer"
          className="size-5 object-contain"
          onError={() => (siteIcon ? setDesktopIcon(null) : setFailed(true))}
        />
      ) : (
        <KeyRoundIcon className="size-4 text-muted-foreground" />
      )}
    </span>
  );
}
