(() => {
  const form = document.getElementById("onboard-form");
  if (!form) return;
  const steps = [...form.querySelectorAll("[data-step]")];
  const back = document.getElementById("wizard-back");
  const next = document.getElementById("wizard-next");
  const save = document.getElementById("wizard-save");
  const status = document.getElementById("wizard-status");
  const volume = document.getElementById("setup-volume");
  let step = 0;
  let busy = false;
  function render() {
    steps.forEach((element, index) => {
      element.hidden = index !== step;
      element.disabled = busy;
    });
    back.disabled = busy || step === 0;
    next.disabled = busy;
    save.disabled = busy;
    next.hidden = step === 3;
    save.hidden = step !== 3;
    document.getElementById("wizard-progress").textContent = `Step ${step + 1} of 4`;
  }
  back.addEventListener("click", () => {
    if (!busy && step > 0) {
      step--;
      render();
    }
  });
  next.addEventListener("click", () => {
    if (!busy && step < 3) {
      step++;
      render();
    }
  });
  volume.addEventListener("input", () => {
    document.getElementById("volume-output").textContent = volume.value;
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (busy || step !== 3) return;
    const body = {
      volume: Number(volume.value),
      dj_role_id: document.getElementById("setup-role").value || null,
      default_text_channel_id: document.getElementById("setup-channel").value || null,
      autoplay_enabled: document.getElementById("setup-autoplay").checked,
    };
    busy = true;
    render();
    status.textContent = "Saving setup…";
    try {
      const response = await fetch(
        `/api/onboard/${encodeURIComponent(document.body.dataset.guildId)}`,
        {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json", "X-Sashimi-Request": "onboard" },
          body: JSON.stringify(body),
        },
      );
      if (!response.ok) {
        const error = await response.json().catch(() => null);
        throw new Error(
          error?.error ||
            `Setup failed (${response.status}). Check your permissions and try again.`,
        );
      }
      status.textContent =
        "Setup saved successfully. The Now Playing channel applies to new voice sessions.";
    } catch (error) {
      status.textContent = error.message;
    } finally {
      busy = false;
      render();
    }
  });
  render();
})();
