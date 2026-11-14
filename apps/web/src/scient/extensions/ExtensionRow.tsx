import {
  isExtensionIconDataUri,
  type EnvironmentId,
  type ExtensionAudience,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { PlugIcon, type LucideIcon } from "lucide-react";
import { createContext, useContext, useState, type ReactNode } from "react";

import { extensionMarkLayout } from "./extensionIconLayout";
import { cn } from "../../lib/utils";
import { useEnvironmentQuery } from "../../state/query";
import { useOptionalExtensionsEnvironment } from "./ExtensionsPage";
import { extensionsBrandIcon, extensionsProviderStoreEntry } from "./extensionsState";
import { WorksWithAgents, WorksWithValue } from "./WorksWith";

/** How rows lay out: two columns of cards, or one table like claude.ai's Connectors page. */
const RowLayout = createContext<"grid" | "table">("grid");

/** What kind of thing a row is, for the table's Type column. */
function rowType(target: ExtensionTarget, audience: ExtensionAudience | undefined): string {
  switch (target.kind) {
    case "connector":
    case "server":
      return "Connector";
    case "plugin":
      return "Built in";
    case "account":
      return "Account app";
    case "provider-plugin":
      return audience?.layer === "agent" ? `${audience.label} plugin` : "Plugin";
    case "provider-store":
      return "Store plugin";
    case "provider-server":
      return "MCP server";
  }
}

/** Every place an extension row or button can open. */
export type ExtensionTarget =
  | { readonly kind: "provider-store"; readonly instanceId: string; readonly entryId: string }
  | { readonly kind: "connector"; readonly connectorId: string }
  | { readonly kind: "server"; readonly name: string }
  | { readonly kind: "plugin"; readonly pluginId: string }
  | {
      readonly kind: "provider-plugin";
      readonly instanceId: string;
      readonly pluginId: string;
      readonly workspace: string | undefined;
    }
  | { readonly kind: "provider-server"; readonly instanceId: string; readonly serverName: string }
  | { readonly kind: "account"; readonly serviceId: string };

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
    case "provider-store":
      return (
        <Link
          {...props}
          className={className}
          to="/settings/extensions/item/store/$instanceId/$entryId"
          params={{ instanceId: target.instanceId, entryId: target.entryId }}
        >
          {children}
        </Link>
      );
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
    case "account":
      return (
        <Link
          {...props}
          className={className}
          to="/settings/extensions/item/account/$serviceId"
          params={{ serviceId: target.serviceId }}
        >
          {children}
        </Link>
      );
  }
}

type ExtensionIconSize = "row" | "large" | "avatar" | "small";

/** Avatar icons share the row size and use a round frame. */
const ICON_FRAME: Readonly<Record<ExtensionIconSize, string>> = {
  row: "size-10 rounded-[25%]",
  large: "size-16 rounded-[25%]",
  avatar: "size-10 rounded-full",
  small: "size-8 rounded-[25%]",
};

const renderedIcons = new Map<string, string>();

function renderIcon(image: HTMLImageElement, url: string): string {
  const cached = renderedIcons.get(url);
  if (cached !== undefined) return cached;
  const canvas = document.createElement("canvas");
  const scale = Math.min(1, 512 / Math.max(image.naturalWidth, image.naturalHeight));
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const context = canvas.getContext("2d", { willReadFrequently: true });
  let result = url;
  if (context) {
    try {
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      const layout = extensionMarkLayout(
        context.getImageData(0, 0, canvas.width, canvas.height).data,
        canvas.width,
        canvas.height,
      );
      if (layout) {
        const crop = document.createElement("canvas");
        crop.width = crop.height = 256;
        const target = crop.getContext("2d");
        if (target) {
          target.fillStyle = "#ffffff";
          target.fillRect(0, 0, 256, 256);
          target.drawImage(canvas, ...layout.source, ...layout.destination);
          result = crop.toDataURL("image/png");
        }
      }
    } catch {
      // A browser that refuses canvas access can still display the original image.
    }
  }
  if (renderedIcons.size >= 512) renderedIcons.clear();
  renderedIcons.set(url, result);
  return result;
}

function ExtensionIconTile({
  iconUrl,
  glyph: Glyph,
  size = "row",
  unframed = false,
}: {
  readonly name: string;
  readonly iconUrl?: string | undefined;
  /** A Scient-drawn symbol, for built-in features that have no logo. */
  readonly glyph?: LucideIcon | undefined;
  readonly size?: ExtensionIconSize;
  readonly unframed?: boolean;
}) {
  const image = iconUrl !== undefined && isExtensionIconDataUri(iconUrl) ? iconUrl : undefined;
  const [sample, setSample] = useState<{ url: string; rendered: string }>();
  const rendered =
    image && (renderedIcons.get(image) ?? (sample?.url === image ? sample.rendered : image));
  const Icon = Glyph ?? (image === undefined ? PlugIcon : undefined);
  return (
    <span
      aria-hidden
      data-extension-icon={Icon ? "glyph" : "image"}
      className={cn(
        "flex shrink-0 items-center justify-center overflow-hidden border",
        Icon
          ? "border-border bg-white dark:bg-card"
          : "border-border [color-scheme:light] dark:border-white/10",
        Icon && (size === "large" ? "p-2.5" : "p-1.5"),
        ICON_FRAME[size],
        unframed && "size-8 border-0 bg-transparent p-1 opacity-60",
      )}
    >
      {Icon ? (
        <Icon className="size-full text-foreground/75" strokeWidth={1.75} />
      ) : (
        <img
          alt=""
          src={rendered}
          className="size-full object-cover"
          onLoad={(event) => {
            if (image && !renderedIcons.has(image))
              setSample({ url: image, rendered: renderIcon(event.currentTarget, image) });
          }}
        />
      )}
    </span>
  );
}

type ExtensionIconProps = Parameters<typeof ExtensionIconTile>[0] & {
  readonly providerPlugin?: Extract<ExtensionTarget, { kind: "provider-plugin" }> | undefined;
  /** Needed outside ExtensionsPage; inside it the page's environment wins. */
  readonly environmentId?: EnvironmentId | undefined;
};

export function ExtensionIcon(props: ExtensionIconProps) {
  if (props.glyph) {
    return <ExtensionIconTile {...props} />;
  }
  return <ResolvedExtensionIcon {...props} />;
}

function ResolvedExtensionIcon(props: ExtensionIconProps) {
  const page = useOptionalExtensionsEnvironment();
  const environmentId = page?.environmentId ?? props.environmentId;
  const providers = page?.providers ?? [];
  const target = props.providerPlugin;
  const provider =
    target && providers.find((provider) => provider.instanceId === target.instanceId);
  const plugin = provider?.plugins?.find((plugin) => plugin.id === target?.pluginId);
  const own = useEnvironmentQuery(
    environmentId && provider && target
      ? extensionsProviderStoreEntry({
          environmentId,
          input: {
            instanceId: provider.instanceId,
            entryId:
              provider.driver === "codex" ? target.pluginId : (plugin?.name ?? target.pluginId),
          },
        })
      : null,
  );
  const result = useEnvironmentQuery(
    environmentId && props.name.length <= 200
      ? extensionsBrandIcon({ environmentId, input: { names: [props.name] } })
      : null,
  );
  return (
    <ExtensionIconTile
      {...props}
      iconUrl={result.data?.icons[props.name] ?? own.data?.iconUrl ?? props.iconUrl}
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
  facts,
  status,
  trailing,
  feedback,
  audience,
  type,
}: {
  readonly audience?: ExtensionAudience;
  /** The table's Type column, when the target alone does not say it. */
  readonly type?: string | undefined;
  readonly target: ExtensionTarget;
  readonly name: string;
  readonly iconUrl?: string | undefined;
  readonly glyph?: LucideIcon | undefined;
  readonly tagline?: string | undefined;
  readonly facts?: string | undefined;
  /** "Needs sign-in", "Off": plain muted text after the name. */
  readonly status?: string | null | undefined;
  readonly trailing?: ReactNode;
  /** Errors and notices from this row's last action. */
  readonly feedback?: ReactNode;
}) {
  const layout = useContext(RowLayout);
  if (layout === "table")
    return (
      // Rows divide by a line; a hovered row turns into a rounded tile and the lines on both
      // sides of it give way, as on claude.ai's Connectors page.
      <li
        className="group/row min-w-0 border-b border-border/70 transition-colors last:border-b-0 hover:border-transparent has-[+li:hover]:border-transparent"
        data-extension-row={name}
      >
        <div className="relative grid min-h-14 grid-cols-[minmax(0,1fr)_2.5rem] items-center gap-x-4 rounded-xl px-2 py-2 transition-colors group-hover/row:bg-foreground/[0.045] has-[a:focus-visible]:outline has-[a:focus-visible]:outline-ring @min-[720px]/extensions:grid-cols-[minmax(0,1fr)_8rem_7rem_2.5rem]">
          <div className="flex min-w-0 items-center gap-3">
            <ExtensionIcon
              name={name}
              iconUrl={iconUrl}
              glyph={glyph}
              size="small"
              providerPlugin={target.kind === "provider-plugin" ? target : undefined}
            />
            <div className="min-w-0">
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
          </div>
          <span className="hidden truncate text-sm text-muted-foreground @min-[720px]/extensions:block">
            {type ?? rowType(target, audience)}
          </span>
          <div className="relative z-10 hidden min-w-0 overflow-hidden @min-[720px]/extensions:block">
            <WorksWithAgents audience={audience} />
          </div>
          <div className="relative z-10 flex shrink-0 justify-end">{trailing}</div>
        </div>
        {feedback ? <div className="grid gap-1 px-2 pb-2 ps-13">{feedback}</div> : null}
      </li>
    );
  return (
    <li className="flex min-w-0 flex-col" data-extension-row={name}>
      <div className="relative flex items-center gap-3 rounded-xl p-2 transition-colors has-[a:hover]:bg-foreground/[0.035] has-[a:focus-visible]:outline has-[a:focus-visible]:outline-ring">
        <ExtensionIcon
          name={name}
          iconUrl={iconUrl}
          glyph={glyph}
          providerPlugin={target.kind === "provider-plugin" ? target : undefined}
        />
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
          {facts ? <p className="text-xs text-muted-foreground">{facts}</p> : null}
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

/** One table of rows: name, type, the agents that use each, and its action. */
export function ExtensionTable({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    <RowLayout.Provider value="table">
      <div className="-mx-2 min-w-0 overflow-hidden">
        <div
          aria-hidden
          className="hidden grid-cols-[minmax(0,1fr)_8rem_7rem_2.5rem] gap-x-4 border-b border-border/70 px-2 pb-2 text-xs text-muted-foreground transition-colors @min-[720px]/extensions:grid [&:has(+ul>li:first-child:hover)]:border-transparent"
        >
          <span>Name</span>
          <span>Type</span>
          <span>Works with</span>
          <span />
        </div>
        <ul aria-label={label}>{children}</ul>
      </div>
    </RowLayout.Provider>
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
    <ul
      aria-label={label}
      className="-mx-2 grid grid-cols-1 gap-x-6 gap-y-1 @min-[720px]/extensions:grid-cols-2"
    >
      {children}
    </ul>
  );
}
