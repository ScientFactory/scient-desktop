import { ipcRenderer } from "electron";

// This isolated preload exposes no bridge to the document and has no Node file API.
window.addEventListener("DOMContentLoaded", () => {
  document.getElementById("cancel")?.addEventListener("click", () => {
    ipcRenderer.send("scient:conversation-review-action", "cancel");
  });
  document.getElementById("continue")?.addEventListener("click", () => {
    ipcRenderer.send("scient:conversation-review-action", "continue");
  });
  const read = document.getElementById("read");
  read?.addEventListener("toggle", () => {
    ipcRenderer.send(
      "scient:conversation-review-action",
      read instanceof HTMLDetailsElement && read.open ? "expand" : "collapse",
    );
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") ipcRenderer.send("scient:conversation-review-action", "cancel");
  });
});
