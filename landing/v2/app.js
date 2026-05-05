// APICover landing v2 — minimal client.
// 1) Waitlist form submit (POSTs to ENDPOINT, falls back to localStorage in dev)
// 2) IntersectionObserver reveal on [data-reveal] (no-op under reduced motion)

(() => {
  // ---------- Waitlist form ----------
  // Set this to your intake URL (Formspree / Tally / custom backend).
  // Empty string → submissions are stored in localStorage["apicover.waitlist.v2"].
  const ENDPOINT = "";

  const form = document.getElementById("waitlist");
  const note = document.getElementById("waitlist-note");

  function setNote(text, tone) {
    if (!note) return;
    note.textContent = text;
    if (tone) note.dataset.tone = tone;
    else delete note.dataset.tone;
  }

  if (form && note) {
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const email = form.elements.email.value.trim();
      const context = form.elements.context.value.trim();

      if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
        setNote("Enter a valid email.", "warn");
        return;
      }
      setNote("Sending…");

      const payload = {
        email,
        context,
        at: new Date().toISOString(),
        source: location.href,
        version: "v2",
      };

      try {
        if (ENDPOINT) {
          const res = await fetch(ENDPOINT, {
            method: "POST",
            headers: { "Content-Type": "application/json", "Accept": "application/json" },
            body: JSON.stringify(payload),
          });
          if (!res.ok) throw new Error("HTTP " + res.status);
        } else {
          const key = "apicover.waitlist.v2";
          const list = JSON.parse(localStorage.getItem(key) || "[]");
          list.push(payload);
          localStorage.setItem(key, JSON.stringify(list));
        }
        setNote("On the list. We'll reply soon.", "ok");
        form.reset();
      } catch {
        setNote("Couldn't send. Email hello@apicover.com instead.", "warn");
      }
    });
  }

  // ---------- Reveal-on-scroll ----------
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const targets = document.querySelectorAll("[data-reveal]");

  if (reduceMotion || !("IntersectionObserver" in window)) {
    targets.forEach((el) => el.classList.add("in-view"));
    return;
  }

  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          entry.target.classList.add("in-view");
          io.unobserve(entry.target);
        }
      }
    },
    { rootMargin: "0px 0px -10% 0px", threshold: 0.05 }
  );

  targets.forEach((el) => io.observe(el));
})();
