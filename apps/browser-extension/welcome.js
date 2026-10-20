import { bindPairing, request } from "./pairing-view.js";

const steps = {
  find: document.getElementById("step-find"),
  approve: document.getElementById("step-approve"),
  use: document.getElementById("step-use"),
};
const setup = document.getElementById("setup");
const done = document.getElementById("done");
const renderPairing = bindPairing(document.getElementById("pairing"), () => void refresh());
let started = false;

function setSteps(active) {
  const order = ["find", "approve", "use"];
  const activeIndex = order.indexOf(active);
  order.forEach((name, index) => {
    steps[name].dataset.state =
      index < activeIndex ? "done" : index === activeIndex ? "active" : "pending";
  });
}

function render(state) {
  const connected = state.hasToken;
  setup.hidden = connected;
  done.hidden = !connected;
  if (connected) {
    setSteps("use");
    steps.use.dataset.state = "done";
    return;
  }
  const phase = state.pairing?.phase ?? "idle";
  setSteps(phase === "waiting" ? "approve" : "find");
  renderPairing(state.pairing);
}

async function refresh() {
  const state = await request({ type: "get-state" });
  render(state);
  if (!started && !state.hasToken && (state.pairing?.phase ?? "idle") === "idle") {
    started = true;
    await request({ type: "start-pairing" });
  }
}

document.getElementById("close-button").addEventListener("click", () => window.close());

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "state-changed") void refresh();
});

void refresh();
