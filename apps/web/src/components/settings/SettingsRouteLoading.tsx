import { Button } from "../ui/button";

/** Settings keeps its navigation shell while the destination code is loading. */
export function SettingsRoutePending() {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-6" role="status">
      <p className="text-sm text-muted-foreground">Loading settings…</p>
    </div>
  );
}

/** Reload also retries failed lazy imports, whose rejected promise is cached by the router. */
export function SettingsRouteError() {
  return (
    <div
      className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6"
      role="alert"
    >
      <p className="text-sm text-muted-foreground">Couldn’t open this Settings page.</p>
      <Button size="sm" variant="outline" onClick={() => window.location.reload()}>
        Reload app
      </Button>
    </div>
  );
}
