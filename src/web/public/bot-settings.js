(() => {
  const form = document.getElementById("bot-settings");
  if (!form) return;
  let busy = false;
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (busy) return;
    busy = true;
    const button = form.querySelector("button");
    button.disabled = true;
    const status = document.getElementById("bot-settings-status");
    status.textContent = "Saving…";
    try {
      const response = await fetch("/api/admin/bot", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", "X-Sashimi-Request": "bot" },
        body: JSON.stringify({
          status: document.getElementById("bot-status").value,
          activity: document.getElementById("bot-activity").value,
          providers: Object.fromEntries(
            [...form.querySelectorAll("[data-provider]")].map((input) => [
              input.dataset.provider,
              input.checked,
            ]),
          ),
        }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => null);
        throw new Error(data?.error || `Could not save (${response.status}).`);
      }
      status.textContent = "Bot settings saved.";
    } catch (error) {
      status.textContent = error.message;
    } finally {
      busy = false;
      button.disabled = false;
    }
  });
})();
