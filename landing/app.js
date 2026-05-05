// APICover landing v1 — client.
// 1) Waitlist form (extracted from inline script, behavior unchanged).
// 2) Animated product showcase: 3 tabs auto-cycling on a 6s-per-stage loop,
//    pauses on hover, gated by IntersectionObserver, respects reduced motion.

(() => {
  // ============================================================
  // Waitlist
  // ============================================================
  const ENDPOINT = ""; // Formspree / Tally / custom URL goes here.

  function attachForm(formId, noteId) {
    const form = document.getElementById(formId);
    const note = document.getElementById(noteId);
    if (!form) return;
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const email = form.elements.email.value.trim();
      const context = form.elements.context ? form.elements.context.value.trim() : "";
      if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
        note.textContent = "Enter a valid email.";
        note.dataset.tone = "warn";
        return;
      }
      note.textContent = "Sending…";
      note.dataset.tone = "neutral";

      const payload = { email, context, at: new Date().toISOString(), source: location.href };

      try {
        if (ENDPOINT) {
          const res = await fetch(ENDPOINT, {
            method: "POST",
            headers: { "Content-Type": "application/json", "Accept": "application/json" },
            body: JSON.stringify(payload),
          });
          if (!res.ok) throw new Error("HTTP " + res.status);
        } else {
          const key = "apicover.waitlist";
          const list = JSON.parse(localStorage.getItem(key) || "[]");
          list.push(payload);
          localStorage.setItem(key, JSON.stringify(list));
        }
        note.textContent = "On the list. We'll reply soon.";
        note.dataset.tone = "ok";
        form.reset();
      } catch {
        note.textContent = "Couldn't send. Email hello@apicover.com instead.";
        note.dataset.tone = "warn";
      }
    });
  }

  attachForm("waitlist-hero", "waitlist-hero-note");
  attachForm("waitlist-main", "waitlist-main-note");

  // ============================================================
  // Hero capabilities card — one-shot fade-up on first visibility
  // ============================================================
  const capsCard = document.querySelector(".caps-card");
  if (capsCard && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    if ("IntersectionObserver" in window) {
      const capsIO = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (entry.isIntersecting && !capsCard.classList.contains("is-played")) {
              capsCard.classList.add("is-played");
              capsIO.unobserve(capsCard);
            }
          }
        },
        { threshold: 0.3 }
      );
      capsIO.observe(capsCard);
    } else {
      capsCard.classList.add("is-played");
    }
  }

  // ============================================================
  // Showcase
  // ============================================================
  const showcase = document.querySelector(".showcase");
  if (!showcase) return;

  const STAGES = ["discover", "compose", "branch", "scenarios"];
  const STAGE_MS = { discover: 9000, compose: 17000, branch: 6000, scenarios: 10000 };

  // Discover sub-stage caption timing (relative to stage start)
  const DISCOVER_SUBSTAGES = [
    { at:    0, text: "discovering routes" },
    { at: 3200, text: "right-click → quick call · breakpoint · cases" },
    { at: 6500, text: "group nodes into business flows" },
  ];

  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const tabs = Array.from(showcase.querySelectorAll(".showcase-tab"));
  const scenes = Array.from(showcase.querySelectorAll(".scene"));
  const meta = showcase.querySelector(".showcase-meta-text");
  const indicator = showcase.querySelector(".showcase-indicator");
  const progress = showcase.querySelector(".showcase-progress-fill");

  let activeIdx = 0;
  let cycleTimer = null;
  let isPaused = false;
  let isVisible = false;
  let progressStart = 0;
  let progressFrame = null;
  let substageTimers = [];
  let stageStartedAt = 0;

  function setIndicator(idx) {
    if (!indicator || !tabs[idx]) return;
    const tab = tabs[idx];
    indicator.style.transform = `translateX(${tab.offsetLeft}px)`;
    indicator.style.width = `${tab.offsetWidth}px`;
  }

  function setMeta(text) {
    if (meta) meta.textContent = text;
  }

  const META_BY_STAGE = {
    discover:  "discover · 6 endpoints assembled · 1 case-set anchor",
    compose:   "compose · live JSONLogic · request body bound to upstream response",
    branch:    "branch · IL walk · 6 calls · 1 external HTTP · 1 database",
    scenarios: "scenarios · 4 linked flows · 12 branches · run together",
  };

  function clearSubstageTimers() {
    substageTimers.forEach((t) => clearTimeout(t));
    substageTimers = [];
  }

  function scheduleDiscoverSubstages() {
    clearSubstageTimers();
    const sub = showcase.querySelector(".d-substage");
    if (!sub) return;
    DISCOVER_SUBSTAGES.forEach((s) => {
      substageTimers.push(setTimeout(() => { sub.textContent = s.text; }, s.at));
    });
  }

  function activate(idx, { resetProgress = true } = {}) {
    activeIdx = idx;
    const stage = STAGES[idx];
    tabs.forEach((t, i) => {
      const on = i === idx;
      t.classList.toggle("is-active", on);
      t.setAttribute("aria-selected", on ? "true" : "false");
      t.tabIndex = on ? 0 : -1;
    });
    scenes.forEach((s, i) => {
      const on = i === idx;
      s.classList.toggle("is-active", on);
      // Restart CSS animations by re-flowing the scene
      if (on) {
        s.classList.remove("is-playing");
        // eslint-disable-next-line no-unused-expressions
        void s.offsetWidth;
        s.classList.add("is-playing");
      }
    });
    setIndicator(idx);
    setMeta(META_BY_STAGE[stage]);
    clearSubstageTimers();
    if (stage === "discover") scheduleDiscoverSubstages();
    if (resetProgress) restartProgress();
  }

  function currentStageMs() {
    return STAGE_MS[STAGES[activeIdx]] || 6000;
  }

  function next() {
    if (isPaused || !isVisible || reduceMotion) return;
    activate((activeIdx + 1) % STAGES.length);
    scheduleNext();
  }
  function scheduleNext(ms) {
    stopCycle();
    const dur = ms ?? currentStageMs();
    stageStartedAt = performance.now();
    cycleTimer = setTimeout(next, dur);
  }
  function startCycle() {
    if (reduceMotion) return;
    scheduleNext();
  }
  function resumeCycle() {
    if (reduceMotion) return;
    const elapsed = performance.now() - stageStartedAt;
    const remaining = Math.max(0, currentStageMs() - elapsed);
    scheduleNext(remaining);
  }
  function stopCycle() {
    if (cycleTimer) {
      clearTimeout(cycleTimer);
      cycleTimer = null;
    }
  }

  // Progress bar (CSS-driven, 0→100% width over current stage's duration)
  function restartProgress() {
    if (!progress || reduceMotion) return;
    const ms = currentStageMs();
    progress.style.transition = "none";
    progress.style.width = "0%";
    if (progressFrame) cancelAnimationFrame(progressFrame);
    progressFrame = requestAnimationFrame(() => {
      progressFrame = requestAnimationFrame(() => {
        progress.style.transition = `width ${ms}ms linear`;
        progress.style.width = "100%";
      });
    });
    progressStart = performance.now();
  }
  function pauseProgress() {
    if (!progress || reduceMotion) return;
    const ms = currentStageMs();
    const elapsed = performance.now() - progressStart;
    const pct = Math.min(100, (elapsed / ms) * 100);
    progress.style.transition = "none";
    progress.style.width = `${pct}%`;
  }
  function resumeProgress() {
    if (!progress || reduceMotion) return;
    const ms = currentStageMs();
    const current = parseFloat(progress.style.width) || 0;
    const remaining = ms * (1 - current / 100);
    progress.style.transition = `width ${remaining}ms linear`;
    progress.style.width = "100%";
    progressStart = performance.now() - (ms - remaining);
  }

  // Tab interactions
  tabs.forEach((tab, i) => {
    tab.addEventListener("click", () => {
      activate(i);
      if (!isPaused && isVisible && !reduceMotion) startCycle();
    });
  });

  showcase.addEventListener("keydown", (e) => {
    const focused = document.activeElement;
    if (!tabs.includes(focused)) return;
    let nextIdx = null;
    if (e.key === "ArrowRight") nextIdx = (activeIdx + 1) % tabs.length;
    if (e.key === "ArrowLeft")  nextIdx = (activeIdx - 1 + tabs.length) % tabs.length;
    if (e.key === "Home")       nextIdx = 0;
    if (e.key === "End")        nextIdx = tabs.length - 1;
    if (nextIdx !== null) {
      e.preventDefault();
      tabs[nextIdx].focus();
      activate(nextIdx);
      if (!isPaused && isVisible && !reduceMotion) startCycle();
    }
  });

  // Hover pause
  const stage = showcase.querySelector(".showcase-stage");
  let pausedElapsed = 0;
  if (stage) {
    stage.addEventListener("mouseenter", () => {
      isPaused = true;
      pausedElapsed = performance.now() - stageStartedAt;
      stopCycle();
      pauseProgress();
    });
    stage.addEventListener("mouseleave", () => {
      isPaused = false;
      if (isVisible && !reduceMotion) {
        // Restore stage start so remaining-time math is correct
        stageStartedAt = performance.now() - pausedElapsed;
        resumeProgress();
        resumeCycle();
      }
    });
  }

  // Visibility gate
  if ("IntersectionObserver" in window && !reduceMotion) {
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            if (!isVisible) {
              isVisible = true;
              activate(0);
              startCycle();
            }
          } else {
            isVisible = false;
            stopCycle();
          }
        }
      },
      { threshold: 0.3 }
    );
    io.observe(showcase);
  } else {
    // Fallback: activate first stage, no auto-cycle under reduced motion
    activate(0, { resetProgress: false });
  }

  // Re-position indicator on resize
  window.addEventListener("resize", () => setIndicator(activeIdx));

  // Initial indicator placement after fonts load (avoid mis-measuring)
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(() => setIndicator(activeIdx));
  }
})();
