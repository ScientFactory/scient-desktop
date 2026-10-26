import { isExtensionIconDataUri, type ExtensionAudience } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { ProjectMonogram } from "../../components/ProjectMonogram";
import { cn } from "../../lib/utils";
import { WorksWithValue } from "./WorksWith";
import { iconTint } from "./extensionsView";

/** Every place an extension row or button can open. */
export type ExtensionTarget =
  | { readonly kind: "connector"; readonly connectorId: string }
  | { readonly kind: "server"; readonly name: string }
  | { readonly kind: "plugin"; readonly pluginId: string }
  | {
      readonly kind: "provider-plugin";
      readonly instanceId: string;
      readonly pluginId: string;
      readonly workspace: string | undefined;
    }
  | { readonly kind: "provider-server"; readonly instanceId: string; readonly serverName: string };

/** The detail page of `target`, carrying the settings scope like every settings link. */
function ExtensionLink({
  target,
  className,
  children,
  ...props
}: {
  readonly target: ExtensionTarget;
  readonly className?: string;
  readonly children?: ReactNode;
  readonly "aria-label"?: string;
}) {
  switch (target.kind) {
    case "connector":
      return (
        <Link
          {...props}
          className={className}
          to="/settings/extensions/item/connector/$connectorId"
          params={{ connectorId: target.connectorId }}
        >
          {children}
        </Link>
      );
    case "server":
      return (
        <Link
          {...props}
          className={className}
          to="/settings/extensions/item/server/$"
          params={{ _splat: target.name }}
        >
          {children}
        </Link>
      );
    case "plugin":
      return (
        <Link
          {...props}
          className={className}
          to="/settings/extensions/item/plugin/$pluginId"
          params={{ pluginId: target.pluginId }}
        >
          {children}
        </Link>
      );
    case "provider-plugin":
      return (
        <Link
          {...props}
          className={className}
          to="/settings/extensions/item/provider/$instanceId/plugin/$pluginId"
          params={{ instanceId: target.instanceId, pluginId: target.pluginId }}
          search={(previous) => ({
            ...previous,
            ...(target.workspace ? { workspace: target.workspace } : {}),
          })}
        >
          {children}
        </Link>
      );
    case "provider-server":
      return (
        <Link
          {...props}
          className={className}
          to="/settings/extensions/item/provider/$instanceId/server/$serverName"
          params={{ instanceId: target.instanceId, serverName: target.serverName }}
        >
          {children}
        </Link>
      );
  }
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

type ExtensionIconSize = "row" | "large" | "avatar";

/** Tile size and inner padding; avatar icons are round. */
const ICON_FRAME: Readonly<Record<ExtensionIconSize, string>> = {
  row: "size-10 p-1.5 rounded-[25%]",
  large: "size-16 p-2.5 rounded-[25%]",
  avatar: "size-10 p-1.5 rounded-full",
};

const MONOGRAM_FRAME: Readonly<Record<ExtensionIconSize, string>> = {
  row: "size-10",
  large: "size-16",
  avatar: "size-10 rounded-full",
};

/**
 * The entry's own image when it is an allowed inline image
 * (`data:image/png|jpeg|webp|svg+xml;base64`, so nothing loads from
 * elsewhere), otherwise its first letter on a tint derived from its name.
 */
export function ExtensionIcon({
  name,
  iconUrl,
  glyph: Glyph,
  size = "row",
}: {
  readonly name: string;
  readonly iconUrl?: string | undefined;
  /** A Scient-drawn symbol, for built-in features that have no logo. */
  readonly glyph?: LucideIcon | undefined;
  readonly size?: ExtensionIconSize;
}) {
  const image = iconUrl !== undefined && isExtensionIconDataUri(iconUrl) ? iconUrl : undefined;
  if (image !== undefined || Glyph) {
    // Many logos disappear on dark backgrounds or recolour with dark mode; render them on a white
    // tile in the light scheme. Scient glyphs still follow the theme.
    return (
      <span
        aria-hidden
        data-extension-icon={Glyph ? "glyph" : "image"}
        className={cn(
          "flex shrink-0 items-center justify-center overflow-hidden border",
          Glyph
            ? "border-border bg-white dark:bg-card"
            : "border-border bg-white [color-scheme:light] dark:border-white/10",
          ICON_FRAME[size],
        )}
      >
        {Glyph ? (
          <Glyph className="size-full text-foreground/75" strokeWidth={1.75} />
        ) : (
          <img alt="" src={image} className="size-full object-contain" />
        )}
      </span>
    );
  }
  const first = graphemes.segment(name.trim()).containing(0)?.segment ?? "?";
  return (
    <ProjectMonogram
      text={first.toLocaleUpperCase()}
      color={iconTint(name)}
      className={MONOGRAM_FRAME[size]}
    />
  );
}

/**
 * One extension in a list: icon, name with a short status, one-line tagline,
 * and a trailing action. The whole row opens the detail page; the trailing
 * action sits above that link.
 */
export function ExtensionRow({
  target,
  name,
  iconUrl,
  glyph,
  tagline,
  status,
  trailing,
  feedback,
  audience,
}: {
  readonly audience?: ExtensionAudience;
  readonly target: ExtensionTarget;
  readonly name: string;
  readonly iconUrl?: string | undefined;
  readonly glyph?: LucideIcon | undefined;
  readonly tagline?: string | undefined;
  /** "Needs sign-in", "Off": plain muted text after the name. */
  readonly status?: string | null | undefined;
  readonly trailing?: ReactNode;
  /** Errors and notices from this row's last action. */
  readonly feedback?: ReactNode;
}) {
  return (
    <li className="flex min-w-0 flex-col" data-extension-row={name}>
      <div className="relative flex items-center gap-3 rounded-xl p-2 transition-colors has-[a:hover]:bg-foreground/[0.035] has-[a:focus-visible]:ring-2 has-[a:focus-visible]:ring-inset has-[a:focus-visible]:ring-ring">
        <ExtensionIcon name={name} iconUrl={iconUrl} glyph={glyph} />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-baseline gap-1.5">
            <ExtensionLink
              target={target}
              className="truncate text-sm font-medium text-foreground outline-none after:absolute after:inset-0 after:rounded-xl"
            >
              {name}
            </ExtensionLink>
            {status ? (
              <span className="shrink-0 text-xs text-muted-foreground" data-extension-status="">
                {status}
              </span>
            ) : null}
          </div>
          {tagline ? <p className="truncate text-xs text-muted-foreground">{tagline}</p> : null}
        </div>
        {trailing ? <div className="relative z-10 shrink-0">{trailing}</div> : null}
      </div>
      <div className="relative z-10 px-2 ps-15 text-xs text-muted-foreground">
        <WorksWithValue audience={audience} />
      </div>
      {feedback ? <div className="grid gap-1 px-2 pb-1 ps-15">{feedback}</div> : null}
    </li>
  );
}

/** Two columns from 640px, one below. No borders: rows separate by space. */
export function ExtensionGrid({
  label,
  children,
}: {
  readonly label?: string;
  readonly children: ReactNode;
}) {
  return (
    <ul aria-label={label} className="-mx-2 grid grid-cols-1 gap-x-6 gap-y-1 sm:grid-cols-2">
      {children}
    </ul>
  );
}
