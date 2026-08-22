(() => {
  "use strict";

  // -----------------------------------------------------------------
  // Splash screen: a brief themed intro on every load. Self-contained
  // on purpose — it doesn't touch or depend on anything else below, so
  // it's easy to change or remove independently.
  // -----------------------------------------------------------------
  const splash = document.getElementById("splash");
  if (splash) {
    const prefersReducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)"
    ).matches;
    // Reduced-motion users still get it, just without asking them to
    // wait through an animation they didn't want.
    const holdMs = prefersReducedMotion ? 120 : 950;

    const dismiss = () => {
      splash.classList.add("is-leaving");
      if (prefersReducedMotion) {
        // Transitions are disabled globally in this case, so
        // transitionend will never fire — remove immediately instead
        // of waiting on the fallback timeout below.
        splash.remove();
        return;
      }
      splash.addEventListener("transitionend", () => splash.remove(), {
        once: true,
      });
      // Fallback in case transitionend never fires (e.g. tab was
      // backgrounded mid-transition) — don't leave it stuck forever.
      setTimeout(() => splash.remove(), 700);
    };

    setTimeout(dismiss, holdMs);
  }
})();

(() => {
  "use strict";

  // -----------------------------------------------------------------
  // Theme toggle (persisted; default is set inline in index.html to
  // avoid a flash of the wrong theme before this script runs)
  // -----------------------------------------------------------------
  const THEME_KEY = "markdown-to-pdf:theme";
  const themeToggle = document.getElementById("themeToggle");

  function setStoredTheme(theme) {
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch (err) {
      /* private mode / storage disabled — theme just won't persist */
    }
  }

  function applyTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    themeToggle.setAttribute(
      "aria-label",
      theme === "dark" ? "Switch to light theme" : "Switch to dark theme"
    );
  }

  themeToggle.addEventListener("click", () => {
    const current = document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
    const next = current === "dark" ? "light" : "dark";
    applyTheme(next);
    setStoredTheme(next);
  });

  // Sync the toggle's label with whatever theme index.html's inline
  // script already applied (it sets the attribute; this just labels it).
  applyTheme(document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light");

  // markdown-it is loaded globally by vendor/markdown-it.min.js. Configured
  // identically (conceptually) to the backend's markdown-it-py setup in
  // app/markdown.py, so the live preview matches the generated PDF.
  const md = window.markdownit({
    html: false,
    linkify: true,
    typographer: false,
  });

  const MAX_FILE_BYTES = 5 * 1024 * 1024; // spec section 17

  const dropzone = document.getElementById("dropzone");
  const fileInput = document.getElementById("fileInput");
  const chooseFileBtn = document.getElementById("chooseFileBtn");
  const editor = document.getElementById("editor");
  const preview = document.getElementById("preview");
  const downloadBtn = document.getElementById("downloadBtn");
  const downloadBtnLabel = document.getElementById("downloadBtnLabel");
  const clearBtn = document.getElementById("clearBtn");
  const sampleBtn = document.getElementById("sampleBtn");
  const statusMessage = document.getElementById("statusMessage");

  /** Name of the file the current editor contents were loaded from, if any. */
  let originalFilename = null;
  let previewDebounceHandle = null;

  // ---------------------------------------------------------------------
  // Status messages
  // ---------------------------------------------------------------------
  function setStatus(message, kind) {
    statusMessage.textContent = message || "";
    statusMessage.classList.remove("is-error", "is-success");
    if (kind === "error") statusMessage.classList.add("is-error");
    if (kind === "success") statusMessage.classList.add("is-success");
  }

  // ---------------------------------------------------------------------
  // Preview rendering
  // ---------------------------------------------------------------------
  function renderPreviewNow() {
    const text = editor.value;
    if (!text.trim()) {
      preview.classList.add("preview-empty");
      preview.innerHTML = '<p class="empty-hint">Your rendered notes will appear here.</p>';
      return;
    }
    preview.classList.remove("preview-empty");
    preview.innerHTML = md.render(text);
  }

  function schedulePreviewRender() {
    if (previewDebounceHandle) clearTimeout(previewDebounceHandle);
    previewDebounceHandle = setTimeout(renderPreviewNow, 120);
  }

  function updateDownloadEnabled() {
    downloadBtn.disabled = !editor.value.trim();
  }

  editor.addEventListener("input", () => {
    updateDownloadEnabled();
    schedulePreviewRender();
  });

  // ---------------------------------------------------------------------
  // File loading (upload, drag & drop)
  // ---------------------------------------------------------------------
  function loadMarkdownIntoEditor(text, filename) {
    editor.value = text;
    originalFilename = filename || null;
    updateDownloadEnabled();
    renderPreviewNow();
    setStatus("");
  }

  function handleFile(file) {
    if (!file) return;

    const looksLikeMarkdown = /\.(md|markdown)$/i.test(file.name) ||
      file.type === "text/markdown" ||
      file.type === "text/plain" ||
      file.type === "";
    if (!looksLikeMarkdown) {
      setStatus("Unable to read this file.", "error");
      return;
    }

    if (file.size > MAX_FILE_BYTES) {
      setStatus("The Markdown document is too large.", "error");
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      loadMarkdownIntoEditor(String(reader.result), file.name);
    };
    reader.onerror = () => {
      setStatus("Unable to read this file.", "error");
    };
    reader.readAsText(file);
  }

  chooseFileBtn.addEventListener("click", () => fileInput.click());

  fileInput.addEventListener("change", () => {
    const file = fileInput.files && fileInput.files[0];
    handleFile(file);
    fileInput.value = ""; // allow re-selecting the same file later
  });

  ["dragenter", "dragover"].forEach((evt) => {
    dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      dropzone.classList.add("is-dragover");
    });
  });

  ["dragleave", "dragend"].forEach((evt) => {
    dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      dropzone.classList.remove("is-dragover");
    });
  });

  dropzone.addEventListener("drop", (e) => {
    e.preventDefault();
    dropzone.classList.remove("is-dragover");
    const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    handleFile(file);
  });

  // ---------------------------------------------------------------------
  // Clear / sample
  // ---------------------------------------------------------------------
  clearBtn.addEventListener("click", () => {
    loadMarkdownIntoEditor("", null);
    editor.focus();
  });

  const SAMPLE_MARKDOWN = `# Information Retrieval — Revision Notes

## 1. Boolean Retrieval

A query is evaluated as a **boolean expression** over an *inverted index*.
Documents either match or they don't — there's no ranking.

- Term-at-a-time processing
- Document-at-a-time processing
- Common operators: \`AND\`, \`OR\`, \`NOT\`

## 2. Evaluation Metrics

| Metric    | Formula                              |
|-----------|---------------------------------------|
| Precision | Relevant retrieved / Total retrieved  |
| Recall    | Relevant retrieved / Total relevant   |
| F1        | 2 · (P · R) / (P + R)                 |

## 3. Worked Example

\`\`\`python
def precision(retrieved, relevant):
    hits = len(set(retrieved) & set(relevant))
    return hits / len(retrieved)
\`\`\`

---

See [the course notes](https://example.com) for the full derivation.
`;

  sampleBtn.addEventListener("click", () => {
    loadMarkdownIntoEditor(SAMPLE_MARKDOWN, null);
  });

  // ---------------------------------------------------------------------
  // Download PDF
  // ---------------------------------------------------------------------
  function parseFilenameFromContentDisposition(headerValue, fallback) {
    if (!headerValue) return fallback;
    const match = /filename="?([^";]+)"?/i.exec(headerValue);
    return match ? match[1] : fallback;
  }

  async function extractErrorMessage(response) {
    try {
      const data = await response.json();
      if (data && typeof data.detail === "string") return data.detail;
    } catch (_) {
      // Response body wasn't JSON; fall through to a generic message.
    }
    if (response.status === 413) return "The Markdown document is too large.";
    if (response.status >= 500) return "The server is temporarily unavailable.";
    return "PDF generation failed. Please try again.";
  }

  async function downloadPdf() {
    const markdownText = editor.value;
    if (!markdownText.trim()) {
      setStatus("The Markdown document is empty.", "error");
      return;
    }

    downloadBtn.disabled = true;
    downloadBtnLabel.textContent = "Generating PDF…";
    setStatus("Generating PDF…");

    try {
      const response = await fetch("/api/pdf", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          markdown: markdownText,
          filename: originalFilename,
          page_size: pageSizeDropdown.getValue(),
          margins: marginsDropdown.getValue(),
          font_size: Number(fontSizeDropdown.getValue()),
          page_numbers: pageNumbersToggle.checked,
        }),
      });

      if (!response.ok) {
        setStatus(await extractErrorMessage(response), "error");
        return;
      }

      const blob = await response.blob();
      const filename = parseFilenameFromContentDisposition(
        response.headers.get("Content-Disposition"),
        "document.pdf"
      );

      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);

      setStatus("PDF ready.", "success");
      loadStats(); // reflect the just-completed conversion without a reload
    } catch (err) {
      setStatus("The server is temporarily unavailable.", "error");
    } finally {
      downloadBtn.disabled = !editor.value.trim();
      downloadBtnLabel.textContent = "Download PDF";
    }
  }

  downloadBtn.addEventListener("click", downloadPdf);

  // ---------------------------------------------------------------------
  // Header stats: conversion count + GitHub star button
  // ---------------------------------------------------------------------
  async function loadStats() {
    const conversionCountEl = document.getElementById("conversionCount");
    const githubStarBtn = document.getElementById("githubStarBtn");
    const githubStarCountEl = document.getElementById("githubStarCount");

    try {
      const response = await fetch("/api/stats");
      if (!response.ok) return;
      const data = await response.json();

      conversionCountEl.textContent = data.conversions.toLocaleString();
      githubStarBtn.href = data.github_repo_url;

      // github_stars is null if the count couldn't be fetched (rate
      // limited, repo not set up yet, etc.) — just show the button
      // without a number rather than "null".
      if (typeof data.github_stars === "number") {
        githubStarCountEl.textContent = data.github_stars.toLocaleString();
      }
    } catch (err) {
      // Stats are a nice-to-have; fail silently and leave the placeholders.
    }
  }

  // ---------------------------------------------------------------------
  // Footer quote
  // ---------------------------------------------------------------------
  async function loadQuote() {
    const footerQuoteEl = document.getElementById("footerQuote");
    try {
      const response = await fetch("/api/quote");
      if (!response.ok) return;
      const data = await response.json();
      footerQuoteEl.textContent = `“${data.text}” — ${data.author}`;
    } catch (err) {
      // Quote is decorative; fail silently.
    }
  }

  // ---------------------------------------------------------------------
  // Custom dropdown (page size / margins / font size)
  // ---------------------------------------------------------------------
  // A small reusable listbox-button pattern rather than a native <select>,
  // since a native select's popup can't be restyled to match the theme.
  // Keyboard support: Enter/Space opens, Arrow keys move, Enter/Space
  // selects, Escape closes. Options are hardcoded in index.html to match
  // the allowlists in app/page_options.py — see /api/page-options for the
  // backend's source of truth if these ever need to be regenerated.
  function initDropdown(rootEl, onChange) {
    const trigger = rootEl.querySelector(".dropdown-trigger");
    const valueEl = trigger.querySelector(".dropdown-value");
    const menu = rootEl.querySelector(".dropdown-menu");
    const options = Array.from(menu.querySelectorAll('[role="option"]'));

    options.forEach((opt) => opt.setAttribute("tabindex", "-1"));

    function open() {
      rootEl.dataset.open = "true";
      menu.hidden = false;
      trigger.setAttribute("aria-expanded", "true");
      const selected = menu.querySelector('[aria-selected="true"]') || options[0];
      if (selected) selected.focus();
      document.addEventListener("click", onOutsideClick);
      menu.addEventListener("keydown", onMenuKeydown);
    }

    function close() {
      rootEl.dataset.open = "false";
      menu.hidden = true;
      trigger.setAttribute("aria-expanded", "false");
      document.removeEventListener("click", onOutsideClick);
      menu.removeEventListener("keydown", onMenuKeydown);
    }

    function select(option) {
      options.forEach((o) => o.setAttribute("aria-selected", String(o === option)));
      valueEl.textContent = option.textContent.trim();
      close();
      trigger.focus();
      onChange(option.dataset.value);
    }

    function onOutsideClick(e) {
      if (!rootEl.contains(e.target)) close();
    }

    function onMenuKeydown(e) {
      const idx = options.indexOf(document.activeElement);
      if (e.key === "Escape") {
        close();
        trigger.focus();
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        (options[idx + 1] || options[options.length - 1]).focus();
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        (options[idx - 1] || options[0]).focus();
      } else if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        if (document.activeElement && options.includes(document.activeElement)) {
          select(document.activeElement);
        }
      } else if (e.key === "Tab") {
        close();
      }
    }

    trigger.addEventListener("click", () => {
      if (menu.hidden) open();
      else close();
    });

    options.forEach((option) => {
      option.addEventListener("click", () => select(option));
    });

    return {
      getValue: () =>
        (menu.querySelector('[aria-selected="true"]') || options[0]).dataset.value,
    };
  }

  const pageSizeDropdown = initDropdown(document.getElementById("pageSizeDropdown"), () => {});
  const marginsDropdown = initDropdown(document.getElementById("marginsDropdown"), () => {});
  const fontSizeDropdown = initDropdown(document.getElementById("fontSizeDropdown"), () => {});
  const pageNumbersToggle = document.getElementById("pageNumbersToggle");

  // ---------------------------------------------------------------------
  // View size presets (Compact / Comfortable / Large)
  // ---------------------------------------------------------------------
  const PANEL_SIZE_KEY = "markdown-to-pdf:panel-size";
  const workspace = document.getElementById("workspace");
  const sizePresetButtons = Array.from(document.querySelectorAll(".size-preset-btn"));

  function applyPanelSize(size) {
    workspace.dataset.size = size;
    sizePresetButtons.forEach((btn) => {
      btn.classList.toggle("is-active", btn.dataset.size === size);
    });
  }

  sizePresetButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      const size = btn.dataset.size;
      applyPanelSize(size);
      try {
        localStorage.setItem(PANEL_SIZE_KEY, size);
      } catch (err) {
        /* private mode / storage disabled — just won't persist */
      }
    });
  });

  (function initPanelSize() {
    let stored = null;
    try {
      stored = localStorage.getItem(PANEL_SIZE_KEY);
    } catch (err) {
      /* ignore */
    }
    if (stored === "compact" || stored === "comfortable" || stored === "large") {
      applyPanelSize(stored);
    }
  })();

  // ---------------------------------------------------------------------
  // Per-panel fullscreen (editor or preview), via the Fullscreen API
  // ---------------------------------------------------------------------
  document.querySelectorAll(".panel-fullscreen-btn").forEach((btn) => {
    const panel = document.getElementById(btn.dataset.panel);
    if (!panel || !panel.requestFullscreen) {
      // Fullscreen API unsupported in this browser — don't show a dead button.
      btn.hidden = true;
      return;
    }
    btn.addEventListener("click", () => {
      const isThisPanelFullscreen = document.fullscreenElement === panel;
      if (isThisPanelFullscreen) {
        document.exitFullscreen();
      } else {
        panel.requestFullscreen().catch(() => {
          /* denied or unsupported in this context — no-op */
        });
      }
    });
  });

  // ---------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------
  updateDownloadEnabled();
  renderPreviewNow();
  loadStats();
  loadQuote();
})();
