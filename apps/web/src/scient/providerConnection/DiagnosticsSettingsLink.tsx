import { Link, useRouter } from "@tanstack/react-router";

// No-break spaces keep the path on one line, so a narrow card never starts a line with ">".
const LABEL = "Settings > Maintenance > Diagnostics";

/** "Settings > Maintenance > Diagnostics", linking to that page where the app's router is present. */
export function DiagnosticsSettingsLink() {
  const router = useRouter({ warn: false });
  if (!router) return <span>{LABEL}</span>;
  return (
    <Link
      className="text-foreground/80 underline decoration-border underline-offset-2 transition-colors hover:text-foreground"
      to="/settings/diagnostics"
    >
      {LABEL}
    </Link>
  );
}
