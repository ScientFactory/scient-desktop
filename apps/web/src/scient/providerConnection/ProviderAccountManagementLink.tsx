import { useGT } from "gt-react";
import { ExternalLinkIcon } from "lucide-react";
import { Children } from "react";

const PROVIDER_ACCOUNT_URLS = {
  antigravity: "https://one.google.com/settings",
  claude: "https://claude.ai/settings/billing",
  codex: "https://chatgpt.com/#settings/Subscription",
  // Where Droid itself sends users to manage billing.
  droid: "https://app.factory.ai/settings/billing",
} as const;

export function ProviderAccountManagementLink(props: {
  readonly provider: keyof typeof PROVIDER_ACCOUNT_URLS;
  readonly children: string;
}) {
  const gt = useGT();
  // Inside <T> the translated name can arrive as several text nodes.
  const name = Children.toArray(props.children).join("");
  return (
    <a
      aria-label={gt("{name} settings (opens in browser)", { name })}
      className="inline-flex items-center gap-0.5 text-foreground/80 underline decoration-border underline-offset-2 transition-colors hover:text-foreground"
      href={PROVIDER_ACCOUNT_URLS[props.provider]}
      rel="noreferrer noopener"
      target="_blank"
    >
      <span>{props.children}</span>
      <ExternalLinkIcon aria-hidden className="size-2.5 shrink-0" />
    </a>
  );
}
