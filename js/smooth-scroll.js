/**
 * Smooth scrolling:
 *  - eased scroll to any in-page #link, offset for the sticky nav
 *  - URL hash updated without a jump; target focused for keyboard users
 *  - scroll progress bar, active nav link, back-to-top button
 * Falls back to instant jumps when the user prefers reduced motion.
 */
(() => {
  const root = document.documentElement;
  const reduce = matchMedia("(prefers-reduced-motion: reduce)");
  const ease = (t) => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2); // easeInOutCubic
  let raf = 0;

  const navOffset = () => (document.querySelector(".nav")?.offsetHeight ?? 0) + 8;

  function scrollToY(y, done) {
    cancelAnimationFrame(raf);
    const start = window.scrollY;
    const max = root.scrollHeight - innerHeight;
    const target = Math.max(0, Math.min(y, max));
    const dist = target - start;
    if (reduce.matches || Math.abs(dist) < 2) { root.style.scrollBehavior = "auto"; scrollTo(0, target); root.style.scrollBehavior = ""; done?.(); return; }

    const dur = Math.min(1100, 450 + Math.abs(dist) * 0.25);
    const t0 = performance.now();
    root.style.scrollBehavior = "auto"; // stop the CSS smoothing from fighting the animation
    const cancel = () => { cancelAnimationFrame(raf); root.style.scrollBehavior = ""; };
    addEventListener("wheel", cancel, { once: true, passive: true });
    addEventListener("touchstart", cancel, { once: true, passive: true });

    const step = (now) => {
      const p = Math.min(1, (now - t0) / dur);
      scrollTo(0, start + dist * ease(p));
      if (p < 1) raf = requestAnimationFrame(step);
      else { root.style.scrollBehavior = ""; done?.(); }
    };
    raf = requestAnimationFrame(step);
  }

  function goTo(id, push = true) {
    const el = id === "top" || id === "" ? document.body : document.getElementById(id);
    if (!el) return;
    const y = id === "top" || id === "" ? 0 : el.getBoundingClientRect().top + scrollY - navOffset();
    scrollToY(y, () => {
      if (el.id) { el.setAttribute("tabindex", "-1"); el.focus({ preventScroll: true }); }
    });
    if (push) history.replaceState(null, "", id && id !== "top" ? `#${id}` : location.pathname + location.search);
  }

  document.addEventListener("click", (e) => {
    const a = e.target.closest('a[href^="#"]');
    if (!a || e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey) return;
    const id = decodeURIComponent(a.getAttribute("href").slice(1));
    if (id && id !== "top" && !document.getElementById(id)) return;
    e.preventDefault();
    goTo(id);
  });

  // Land on the right spot (below the sticky nav) when the page opens with a #hash.
  addEventListener("load", () => { if (location.hash.length > 1) setTimeout(() => goTo(decodeURIComponent(location.hash.slice(1)), false), 60); });

  /* Progress bar + back-to-top */
  const bar = document.getElementById("scrollProgress");
  const topBtn = document.getElementById("toTop");
  let ticking = false;
  function onScroll() {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      const max = root.scrollHeight - innerHeight;
      if (bar) bar.style.transform = `scaleX(${max > 0 ? scrollY / max : 0})`;
      if (topBtn) { const show = scrollY > innerHeight * 0.6; topBtn.hidden = false; topBtn.classList.toggle("is-hidden", !show); }
      ticking = false;
    });
  }
  addEventListener("scroll", onScroll, { passive: true });
  addEventListener("resize", onScroll);
  topBtn?.addEventListener("click", () => goTo("top"));
  onScroll();

  /* Highlight the nav link of the section in view */
  const links = [...document.querySelectorAll('.nav__links a[href^="#"]')];
  const sections = links.map((l) => document.getElementById(l.getAttribute("href").slice(1))).filter(Boolean);
  if ("IntersectionObserver" in window && sections.length) {
    const io = new IntersectionObserver((entries) => {
      entries.forEach((en) => {
        if (!en.isIntersecting) return;
        links.forEach((l) => l.classList.toggle("is-active", l.getAttribute("href") === `#${en.target.id}`));
      });
    }, { rootMargin: "-40% 0px -55% 0px" });
    sections.forEach((s) => io.observe(s));
    addEventListener("scroll", () => { if (scrollY < 120) links.forEach((l) => l.classList.remove("is-active")); }, { passive: true });
  }
})();
