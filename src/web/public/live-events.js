(() => {
  window.sashimiLive = (refresh) => {
    let source;
    let fallback;
    let debounce;
    let closed = false;
    function schedule() {
      if (closed || document.hidden || debounce) return;
      debounce = setTimeout(() => {
        debounce = undefined;
        void refresh();
      }, 100);
    }
    function poll() {
      if (!closed && !fallback) fallback = setInterval(schedule, 15000);
    }
    if (typeof window.EventSource === "function") {
      try {
        source = new EventSource("/api/events/stream");
        source.addEventListener("refresh", schedule);
        source.onopen = () => {
          if (fallback) clearInterval(fallback);
          fallback = undefined;
          schedule();
        };
        source.onerror = poll; // Native EventSource retries; polling covers interruptions.
      } catch {
        poll();
      }
    } else poll();
    function close() {
      closed = true;
      source?.close();
      if (fallback) clearInterval(fallback);
      if (debounce) clearTimeout(debounce);
    }
    window.addEventListener("pagehide", close, { once: true });
    return close;
  };
})();
