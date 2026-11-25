(() => {
  const button = document.getElementById("invite-check");
  if (!button) return;
  const note = document.getElementById("invite-check-status");
  const startedAt = Date.now();
  let busy = false;
  let stopped = false;
  let timer;

  async function check() {
    if (busy || stopped || document.hidden) return;
    busy = true;
    button.disabled = true;
    try {
      const response = await fetch("/api/invite/status", {
        credentials: "same-origin",
        cache: "no-store",
      });
      if (!response.ok) throw new Error("Confirmation unavailable");
      const result = await response.json();
      document.getElementById("invite-title").textContent = result.title;
      document.getElementById("invite-message").textContent = result.message;
      if (result.status !== "pending" || !result.canCheck) {
        stopped = true;
        clearInterval(timer);
        button.hidden = true;
        note.textContent =
          result.status === "confirmed"
            ? "Server membership confirmed."
            : "Check your server in Discord or your dashboard. There’s no need to repeat the invite just to check.";
      } else if (Date.now() - startedAt >= 2 * 60_000) {
        clearInterval(timer);
        note.textContent =
          "Confirmation is taking longer than usual. You can check again here, or look for Sashimi in Discord. Don’t repeat the invite just to check.";
      } else {
        note.textContent = "Still waiting for confirmation. Sashimi may already be present.";
      }
    } catch {
      note.textContent =
        "Confirmation is temporarily unavailable. You can check again without repeating the invite.";
      if (Date.now() - startedAt >= 2 * 60_000) clearInterval(timer);
    } finally {
      busy = false;
      button.disabled = false;
    }
  }
  button.addEventListener("click", () => void check());
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) void check();
  });
  timer = setInterval(() => void check(), 5_000);
  void check();
})();
