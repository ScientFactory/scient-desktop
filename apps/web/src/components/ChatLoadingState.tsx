import { SidebarInset } from "./ui/sidebar";

/** Preserve the chat surface while route state is arriving; no animated skeleton. */
export function ChatLoadingState() {
  return (
    <SidebarInset className="h-svh min-h-0 overflow-hidden bg-background text-foreground md:h-dvh">
      <div
        role="status"
        className="flex flex-1 items-center justify-center text-sm text-muted-foreground"
      >
        Opening conversation…
      </div>
    </SidebarInset>
  );
}
