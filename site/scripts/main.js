/**
 * Token Orchestrator Landing Page Scripts
 * Lightweight, zero-dependency client logic
 */

document.addEventListener("DOMContentLoaded", () => {
  initNavbarScroll();
  initHeroTabs();
  initToolFilter();
  initCopyButtons();
  initPlatformDetection();
});

// 1. Navbar dynamic background on scroll
function initNavbarScroll() {
  const header = document.querySelector(".site-header");
  if (!header) return;

  const handleScroll = () => {
    if (window.scrollY > 20) {
      header.classList.add("scrolled");
    } else {
      header.classList.remove("scrolled");
    }
  };

  window.addEventListener("scroll", handleScroll, { passive: true });
  handleScroll();
}

// 2. Hero screenshot tab switcher
function initHeroTabs() {
  const tabs = document.querySelectorAll("[data-hero-tab]");
  const image = document.getElementById("hero-preview-img");
  const title = document.getElementById("hero-preview-title");

  if (!tabs.length || !image) return;

  const screenshotMap = {
    "main": {
      src: "assets/application-main.png",
      alt: "Token Orchestrator — AI Tool Limits overview",
      title: "Token Orchestrator — AI Tool Limits & Usage"
    },
    "limits": {
      src: "assets/application-settings-limits.png",
      alt: "Token Orchestrator — Provider account and limits setup",
      title: "Token Orchestrator — Account & Provider Configuration"
    }
  };

  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      tabs.forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");

      const key = tab.getAttribute("data-hero-tab");
      const target = screenshotMap[key];
      if (target) {
        image.src = target.src;
        image.alt = target.alt;
        if (title) title.textContent = target.title;
      }
    });
  });
}

// 3. Supported tools search and filter
function initToolFilter() {
  const searchInput = document.getElementById("tool-search-input");
  const filterTabs = document.querySelectorAll("[data-tool-filter]");
  const toolChips = document.querySelectorAll("[data-tool-item]");
  const countEl = document.getElementById("filtered-tool-count");

  if (!toolChips.length) return;

  let activeFilter = "all";
  let searchQuery = "";

  const applyFilters = () => {
    let visibleCount = 0;

    toolChips.forEach((chip) => {
      const category = chip.getAttribute("data-category"); // "client" or "limit"
      const name = (chip.getAttribute("data-name") || "").toLowerCase();
      const meta = (chip.getAttribute("data-meta") || "").toLowerCase();

      const matchesFilter = activeFilter === "all" || category === activeFilter;
      const matchesSearch = !searchQuery || name.includes(searchQuery) || meta.includes(searchQuery);

      if (matchesFilter && matchesSearch) {
        chip.style.display = "flex";
        visibleCount++;
      } else {
        chip.style.display = "none";
      }
    });

    if (countEl) {
      countEl.textContent = `${visibleCount} tools`;
    }
  };

  if (searchInput) {
    searchInput.addEventListener("input", (e) => {
      searchQuery = e.target.value.trim().toLowerCase();
      applyFilters();
    });
  }

  filterTabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      filterTabs.forEach((t) => {
        t.classList.remove("active");
        t.setAttribute("aria-selected", "false");
      });
      tab.classList.add("active");
      tab.setAttribute("aria-selected", "true");
      activeFilter = tab.getAttribute("data-tool-filter");
      applyFilters();
    });
  });
}

// 4. One-click copy for command snippets
function initCopyButtons() {
  const buttons = document.querySelectorAll("[data-copy-text]");

  buttons.forEach((btn) => {
    btn.addEventListener("click", async () => {
      const textToCopy = btn.getAttribute("data-copy-text");
      if (!textToCopy) return;

      try {
        await navigator.clipboard.writeText(textToCopy);
        const origHtml = btn.innerHTML;
        btn.classList.add("copied");
        btn.textContent = "Copied!";

        setTimeout(() => {
          btn.classList.remove("copied");
          btn.innerHTML = origHtml;
        }, 2000);
      } catch (err) {
        console.error("Failed to copy", err);
      }
    });
  });
}

// 5. Detect client operating system
function initPlatformDetection() {
  const ua = navigator.userAgent.toLowerCase();
  let os = "windows";

  if (ua.includes("mac")) {
    os = "mac";
  } else if (ua.includes("linux")) {
    os = "linux";
  }

  const badges = document.querySelectorAll(`[data-platform-match="${os}"]`);
  badges.forEach((b) => {
    b.classList.add("recommended");
  });
}
