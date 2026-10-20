export function request(message) {
  return chrome.runtime.sendMessage(message);
}

export function bindPairing(root, onChange) {
  const views = {
    idle: root.querySelector("[data-phase='idle']"),
    searching: root.querySelector("[data-phase='searching']"),
    waiting: root.querySelector("[data-phase='waiting']"),
    problem: root.querySelector("[data-phase='problem']"),
  };
  const code = root.querySelector("[data-pairing-code]");
  const problem = root.querySelector("[data-pairing-problem]");
  const found = root.querySelector("[data-pairing-found]");

  for (const button of root.querySelectorAll("[data-action='start']")) {
    button.addEventListener("click", async () => {
      await request({ type: "start-pairing" });
      onChange?.();
    });
  }
  for (const button of root.querySelectorAll("[data-action='cancel']")) {
    button.addEventListener("click", async () => {
      await request({ type: "cancel-pairing" });
      onChange?.();
    });
  }

  return function renderPairing(pairing) {
    const phase = pairing?.phase ?? "idle";
    const visible =
      phase === "searching" || phase === "waiting"
        ? phase
        : phase === "idle" || phase === "approved"
          ? "idle"
          : "problem";
    for (const [name, element] of Object.entries(views)) {
      if (element) element.hidden = name !== visible;
    }
    if (code) {
      code.replaceChildren();
      const parts = String(pairing?.code ?? "").split("-").filter(Boolean);
      for (const part of parts.length ? parts : ["···", "···"]) {
        const span = document.createElement("span");
        span.textContent = part;
        code.append(span);
      }
    }
    if (found) {
      found.textContent = pairing?.gatewayUrl
        ? `Found Cybara at ${pairing.gatewayUrl.replace(/^https?:\/\//, "")}`
        : "";
    }
    if (problem) {
      problem.textContent =
        phase === "not-found"
          ? "Cybara isn't running on this computer. Open the Cybara app, then try again."
          : pairing?.error || "Something went wrong. Try again.";
    }
  };
}
