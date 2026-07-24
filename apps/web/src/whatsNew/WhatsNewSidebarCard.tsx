// FILE: whatsNew/WhatsNewSidebarCard.tsx
// Purpose: Connect the sidebar placement to the root-owned release-note state.

import { useWhatsNewContext } from "./WhatsNewProvider";
import { WhatsNewPopoutCard } from "./WhatsNewPopoutCard";

export function WhatsNewSidebarCard() {
  const {
    currentEntry,
    currentVersion,
    isPopoutVisible,
    openDialog,
    dismissPopout,
    markPopoutPresented,
    dialogHandle,
  } = useWhatsNewContext();

  if (!currentEntry || !isPopoutVisible) return null;

  return (
    <WhatsNewPopoutCard
      entry={currentEntry}
      currentVersion={currentVersion}
      onOpen={openDialog}
      onDismiss={dismissPopout}
      onPresented={markPopoutPresented}
      dialogHandle={dialogHandle}
    />
  );
}
