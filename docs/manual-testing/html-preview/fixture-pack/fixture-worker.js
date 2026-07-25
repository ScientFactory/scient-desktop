self.addEventListener("message", () => {
  self.postMessage("ready");
});
