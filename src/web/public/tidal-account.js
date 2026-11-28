(() => {
  const button = document.getElementById("tidal-unlink");
  if (!button) return;
  button.addEventListener("click", async () => {
    button.disabled = true;
    const status = document.getElementById("tidal-account-status");
    try {
      const response = await fetch("/auth/tidal/unlink", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", "X-Sashimi-Request": "tidal" },
        body: "{}",
      });
      if (!response.ok)
        throw new Error("Could not unlink Tidal. Check your session and try again.");
      button.hidden = true;
      document.getElementById("tidal-link").hidden = false;
      status.textContent = "Tidal account unlinked.";
    } catch {
      status.textContent = "Could not unlink Tidal. Check your session and try again.";
    } finally {
      button.disabled = false;
    }
  });
})();
