(() => {
  const button = document.getElementById("spotify-unlink");
  if (!button) return;
  button.addEventListener("click", async () => {
    button.disabled = true;
    const status = document.getElementById("spotify-account-status");
    try {
      const response = await fetch("/auth/spotify/unlink", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", "X-Sashimi-Request": "spotify" },
        body: "{}",
      });
      if (!response.ok)
        throw new Error("Could not unlink Spotify. Check your session and try again.");
      button.hidden = true;
      document.getElementById("spotify-link").hidden = false;
      status.textContent = "Spotify account unlinked.";
    } catch (error) {
      status.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });
})();
