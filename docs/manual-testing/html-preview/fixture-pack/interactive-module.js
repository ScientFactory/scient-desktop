document.querySelector("#moduleStatus").textContent = "Module: ready";

fetch("fixture-data.json")
  .then((response) => response.json())
  .then((data) => {
    document.querySelector("#fetchStatus").textContent = `Fetch: ${data.status}`;
  })
  .catch(() => {
    document.querySelector("#fetchStatus").textContent = "Fetch: failed";
  });

const worker = new Worker("fixture-worker.js", { type: "module" });
worker.addEventListener("message", (event) => {
  document.querySelector("#workerStatus").textContent = `Worker: ${event.data}`;
  worker.terminate();
});
worker.postMessage("start");
