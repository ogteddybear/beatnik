(() => {
  function apply(theme) {
    document.documentElement.dataset.bsTheme = theme;
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute("content", theme === "light" ? "#f4f6fb" : "#101827");
    document.querySelectorAll("[data-theme-toggle]").forEach((button) => {
      button.textContent = theme === "dark" ? "Light mode" : "Dark mode";
      button.setAttribute("aria-label", `Switch to ${theme === "dark" ? "light" : "dark"} mode`);
    });
    document.dispatchEvent(new CustomEvent("sashimi:theme", { detail: { theme } }));
  }
  function current() {
    return document.documentElement.dataset.bsTheme === "light" ? "light" : "dark";
  }
  try {
    const saved = localStorage.getItem("sashimi-theme");
    apply(saved === "light" ? "light" : "dark");
  } catch {
    apply("dark");
  }
  document.addEventListener("DOMContentLoaded", () => {
    apply(current());
    document.querySelectorAll("[data-theme-toggle]").forEach((button) =>
      button.addEventListener("click", () => {
        const theme = current() === "dark" ? "light" : "dark";
        apply(theme);
        try {
          localStorage.setItem("sashimi-theme", theme);
        } catch {
          /* Storage is optional. */
        }
      }),
    );
  });
  window.addEventListener("storage", (event) => {
    if (event.key === "sashimi-theme") apply(event.newValue === "light" ? "light" : "dark");
  });
})();
