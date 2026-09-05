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
  const MAX_FILES = 100;
  // Mirrors the backend's own render semaphore (MAX_CONCURRENT_RENDERS in
  // app/pdf.py, default 3) so a big "Download all" batch doesn't pile up
  // far more concurrent requests than the server will actually run at
  // once — extra requests would just queue behind the semaphore anyway.
  const MAX_CONCURRENT_CONVERSIONS = 3;

  // Used the instant the page loads, before /api/page-options has had a
  // chance to answer, so every control is already clickable. Deliberately
  // mirrors what used to be hardcoded in index.html, so behaviour never
  // regresses below "the original 6-size list" even if the fetch below
  // fails (offline, server hiccup, etc.) — it's replaced with the full
  // backend allowlist as soon as that request resolves.
  const FALLBACK_PAGE_OPTIONS = {
    page_size_groups: [
      { label: "Common", sizes: ["A3", "A4", "A5", "Letter", "Legal", "Tabloid"] },
    ],
    margins: ["compact", "normal", "wide"],
    font_size: { min: 8, max: 24, step: 0.1, default: 10.3 },
    defaults: { page_size: "A4", margins: "normal", font_size: 10.3 },
  };

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
  const pageNumbersToggle = document.getElementById("pageNumbersToggle");

  const filesPanel = document.getElementById("filesPanel");
  const filesList = document.getElementById("filesList");
  const filesCountEl = document.getElementById("filesCount");
  const downloadAllBtn = document.getElementById("downloadAllBtn");
  const downloadAllBtnLabel = document.getElementById("downloadAllBtnLabel");

  /**
   * One entry per uploaded file. `content` is kept in sync with the editor
   * whenever this is the active file (see the editor "input" handler
   * below). `pdfBlob`/`pdfFilename`/`optionsSignature` together are the
   * per-file cache: a previous conversion is reused as-is as long as nothing
   * that would change its output — the file's content or the shared page
   * options — has changed since. The cache lives only in this Map, in
   * memory, for as long as the tab is open: nothing is written to the
   * server or to disk, and removing a file (or reloading the page) is what
   * "until the file is removed" means in practice.
   * @typedef {{
   *   id: string, name: string, size: number, content: string,
   *   status: "idle"|"converting"|"ready"|"error",
   *   pdfBlob: Blob|null, pdfFilename: string|null,
   *   optionsSignature: string|null, error: string|null,
   * }} FileEntry
   * @type {Map<string, FileEntry>}
   */
  const files = new Map();
  let activeFileId = null;
  let fileIdCounter = 0;
  let previewDebounceHandle = null;

  // Assigned by buildAndWireOptionControls()/initFontStepper() once the
  // controls exist — see the "Page options" section further down.
  let pageSizeDropdown = null;
  let marginsDropdown = null;
  let fontSizeStepper = null;

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
  // Small helpers
  // ---------------------------------------------------------------------
  function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  }

  const HTML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);
  }

  function makeFileId() {
    fileIdCounter += 1;
    return `f${Date.now().toString(36)}${fileIdCounter}`;
  }

  /** Appends " (2)", " (3)", ... before the extension until `name` is
   * unique among `existingNames` — so two same-named uploads (or a ZIP
   * entry collision) never silently clobber one another. */
  function dedupeName(name, existingNames) {
    if (!existingNames.has(name)) return name;
    const dot = name.lastIndexOf(".");
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : "";
    let n = 2;
    let candidate = `${stem} (${n})${ext}`;
    while (existingNames.has(candidate)) {
      n += 1;
      candidate = `${stem} (${n})${ext}`;
    }
    return candidate;
  }

  function triggerBlobDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  /** Runs `worker` over `items` with at most `limit` in flight at once —
   * used by "Download all" so a batch of 100 files doesn't fire 100
   * simultaneous requests at a single free-tier server instance. */
  async function runWithConcurrency(items, limit, worker) {
    let index = 0;
    const workerCount = Math.max(1, Math.min(limit, items.length));
    const runners = new Array(workerCount).fill(null).map(async () => {
      while (index < items.length) {
        const current = index;
        index += 1;
        await worker(items[current]);
      }
    });
    await Promise.all(runners);
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

    // Keep the active file entry's content in sync, and invalidate its
    // cached PDF (if any) since the source changed underneath it. Only
    // re-render the file list when a visible status actually flips, so
    // fast typing doesn't thrash the DOM on every keystroke.
    if (activeFileId) {
      const entry = files.get(activeFileId);
      if (entry) {
        entry.content = editor.value;
        if (entry.status !== "idle" || entry.pdfBlob) {
          entry.pdfBlob = null;
          entry.pdfFilename = null;
          entry.optionsSignature = null;
          entry.status = "idle";
          entry.error = null;
          renderFilesList();
        }
      }
    }
  });

  // ---------------------------------------------------------------------
  // Ad-hoc editing (paste/type, Clear, Load sample) — content that isn't
  // tied to any uploaded file. Deselects whatever file was active without
  // touching that file's own stored content.
  // ---------------------------------------------------------------------
  function loadAdHocText(text) {
    activeFileId = null;
    editor.value = text;
    updateDownloadEnabled();
    renderPreviewNow();
    setStatus("");
    renderFilesList();
  }

  // ---------------------------------------------------------------------
  // Uploaded-files manager
  // ---------------------------------------------------------------------
  function looksLikeMarkdown(file) {
    return (
      /\.(md|markdown)$/i.test(file.name) ||
      file.type === "text/markdown" ||
      file.type === "text/plain" ||
      file.type === ""
    );
  }

  function readFileAsText(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error("Unable to read this file."));
      reader.readAsText(file);
    });
  }

  function setActiveFile(id) {
    const entry = files.get(id);
    if (!entry) return;
    activeFileId = id;
    editor.value = entry.content;
    updateDownloadEnabled();
    renderPreviewNow();
    setStatus("");
    renderFilesList();
  }

  function removeFile(id) {
    files.delete(id);
    if (activeFileId === id) {
      activeFileId = null;
      editor.value = "";
      updateDownloadEnabled();
      renderPreviewNow();
    }
    renderFilesList();
  }

  async function addFiles(fileList) {
    const incoming = Array.from(fileList || []);
    if (incoming.length === 0) return;

    const remainingSlots = Math.max(0, MAX_FILES - files.size);
    const accepted = [];
    let overflowCount = 0;
    let rejectedType = 0;
    let rejectedSize = 0;

    incoming.forEach((file) => {
      if (accepted.length >= remainingSlots) {
        overflowCount += 1;
        return;
      }
      if (!looksLikeMarkdown(file)) {
        rejectedType += 1;
        return;
      }
      if (file.size > MAX_FILE_BYTES) {
        rejectedSize += 1;
        return;
      }
      accepted.push(file);
    });

    const newIds = [];
    for (const file of accepted) {
      try {
        const content = await readFileAsText(file);
        const id = makeFileId();
        const existingNames = new Set(Array.from(files.values()).map((f) => f.name));
        files.set(id, {
          id,
          name: dedupeName(file.name, existingNames),
          size: file.size,
          content,
          status: "idle",
          pdfBlob: null,
          pdfFilename: null,
          optionsSignature: null,
          error: null,
        });
        newIds.push(id);
      } catch (err) {
        rejectedType += 1;
      }
    }

    renderFilesList();

    // Mirrors the old single-file UX: dropping/picking exactly one file
    // previews it immediately. Multiple at once just populate the list —
    // there's no single obvious file to show in the editor.
    if (newIds.length === 1) {
      setActiveFile(newIds[0]);
    }

    const messages = [];
    if (newIds.length > 0) {
      messages.push(newIds.length === 1 ? "1 file added." : `${newIds.length} files added.`);
    }
    if (overflowCount > 0) {
      messages.push(`${overflowCount} file${overflowCount === 1 ? "" : "s"} skipped — 100 file limit reached.`);
    }
    if (rejectedType > 0) {
      messages.push(`${rejectedType} file${rejectedType === 1 ? "" : "s"} skipped — not readable Markdown.`);
    }
    if (rejectedSize > 0) {
      messages.push(`${rejectedSize} file${rejectedSize === 1 ? "" : "s"} skipped — too large (5 MB limit).`);
    }
    if (messages.length > 0) {
      const hadProblem = overflowCount > 0 || rejectedType > 0 || rejectedSize > 0;
      setStatus(messages.join(" "), hadProblem ? "error" : "success");
    }
  }

  const FILE_STATUS_LABELS = {
    idle: "Not converted",
    converting: "Converting…",
    ready: "Ready",
    error: "Error",
  };

  function renderFilesList() {
    const entries = Array.from(files.values());
    filesPanel.hidden = entries.length === 0;
    filesCountEl.textContent = `${entries.length} / ${MAX_FILES}`;
    downloadAllBtn.disabled = entries.length === 0;

    filesList.innerHTML = entries
      .map((entry) => {
        const isActive = entry.id === activeFileId;
        const isBusy = entry.status === "converting";
        const errorTitle = entry.status === "error" && entry.error
          ? ` title="${escapeHtml(entry.error)}"`
          : "";

        return `
          <li class="file-row${isActive ? " is-active" : ""}" data-id="${entry.id}">
            <button type="button" class="file-row-main" data-action="select" title="${escapeHtml(entry.name)}">
              <span class="file-row-name">${escapeHtml(entry.name)}</span>
              <span class="file-row-meta">
                <span class="file-row-size">${formatBytes(entry.size)}</span>
                <span class="file-row-status file-row-status--${entry.status}"${errorTitle}>${FILE_STATUS_LABELS[entry.status]}</span>
              </span>
            </button>
            <div class="file-row-actions">
              <button type="button" class="icon-btn" data-action="download" aria-label="Download ${escapeHtml(entry.name)} as PDF" ${isBusy ? "disabled" : ""}>
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12m0 0l-4.5-4.5M12 15l4.5-4.5M4 19h16" /></svg>
              </button>
              <button type="button" class="icon-btn icon-btn-danger" data-action="remove" aria-label="Remove ${escapeHtml(entry.name)}" ${isBusy ? "disabled" : ""}>
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
              </button>
            </div>
          </li>
        `;
      })
      .join("");
  }

  filesList.addEventListener("click", (e) => {
    const actionEl = e.target.closest("[data-action]");
    const row = e.target.closest(".file-row");
    if (!actionEl || !row) return;
    const id = row.dataset.id;

    if (actionEl.dataset.action === "select") {
      setActiveFile(id);
    } else if (actionEl.dataset.action === "remove") {
      removeFile(id);
    } else if (actionEl.dataset.action === "download") {
      downloadSingleFile(id);
    }
  });

  chooseFileBtn.addEventListener("click", () => fileInput.click());

  fileInput.addEventListener("change", () => {
    addFiles(fileInput.files);
    fileInput.value = ""; // allow re-selecting the same file(s) later
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
    addFiles(e.dataTransfer && e.dataTransfer.files);
  });

  // ---------------------------------------------------------------------
  // Clear / sample
  // ---------------------------------------------------------------------
  clearBtn.addEventListener("click", () => {
    loadAdHocText("");
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
    loadAdHocText(SAMPLE_MARKDOWN);
  });

  // ---------------------------------------------------------------------
  // PDF generation (shared by the single "Download PDF" button, per-file
  // downloads, and "Download all as ZIP")
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

  /** The current page-options selection, as a string key. Two conversions
   * with the same signature would produce byte-identical PDFs (for the
   * same input), which is exactly what per-file caching relies on to know
   * a stored PDF is still valid. Falls back to FALLBACK_PAGE_OPTIONS's
   * defaults if the controls somehow never finished initializing (see the
   * try/catch around buildAndWireOptionControls in init()) rather than
   * throwing and taking the download down with it. */
  function currentOptionsSignature() {
    return [
      pageSizeDropdown ? pageSizeDropdown.getValue() : FALLBACK_PAGE_OPTIONS.defaults.page_size,
      marginsDropdown ? marginsDropdown.getValue() : FALLBACK_PAGE_OPTIONS.defaults.margins,
      fontSizeStepper ? fontSizeStepper.getValue() : FALLBACK_PAGE_OPTIONS.defaults.font_size,
      pageNumbersToggle.checked,
    ].join("|");
  }

  async function requestPdf(markdownText, filename) {
    const response = await fetch("/api/pdf", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        markdown: markdownText,
        filename: filename,
        page_size: pageSizeDropdown ? pageSizeDropdown.getValue() : FALLBACK_PAGE_OPTIONS.defaults.page_size,
        margins: marginsDropdown ? marginsDropdown.getValue() : FALLBACK_PAGE_OPTIONS.defaults.margins,
        font_size: fontSizeStepper ? fontSizeStepper.getValue() : FALLBACK_PAGE_OPTIONS.defaults.font_size,
        page_numbers: pageNumbersToggle.checked,
      }),
    });

    if (!response.ok) {
      throw new Error(await extractErrorMessage(response));
    }

    const blob = await response.blob();
    const outFilename = parseFilenameFromContentDisposition(
      response.headers.get("Content-Disposition"),
      "document.pdf"
    );
    return { blob, filename: outFilename };
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

    const activeEntry = activeFileId ? files.get(activeFileId) : null;

    try {
      const { blob, filename } = await requestPdf(
        markdownText,
        activeEntry ? activeEntry.name : null
      );
      triggerBlobDownload(blob, filename);

      // Feeds the same cache "Download all" reads from, so converting via
      // this button doesn't get thrown away the moment a batch zip runs.
      if (activeEntry) {
        activeEntry.pdfBlob = blob;
        activeEntry.pdfFilename = filename;
        activeEntry.optionsSignature = currentOptionsSignature();
        activeEntry.status = "ready";
        activeEntry.error = null;
        renderFilesList();
      }

      setStatus("PDF ready.", "success");
      loadStats(); // reflect the just-completed conversion without a reload
    } catch (err) {
      setStatus(err.message || "The server is temporarily unavailable.", "error");
    } finally {
      downloadBtn.disabled = !editor.value.trim();
      downloadBtnLabel.textContent = "Download PDF";
    }
  }

  downloadBtn.addEventListener("click", downloadPdf);

  /** Converts one file entry, unconditionally, and updates its cache. */
  async function convertFileToPdf(entry) {
    entry.status = "converting";
    entry.error = null;
    renderFilesList();
    try {
      const { blob, filename } = await requestPdf(entry.content, entry.name);
      entry.pdfBlob = blob;
      entry.pdfFilename = filename;
      entry.optionsSignature = currentOptionsSignature();
      entry.status = "ready";
      entry.error = null;
      return { blob, filename };
    } catch (err) {
      entry.status = "error";
      entry.error = err.message || "PDF generation failed.";
      throw err;
    } finally {
      renderFilesList();
    }
  }

  /** Reuses a cached PDF if the file's content and the shared page options
   * haven't changed since it was generated; otherwise (re)converts. This
   * is the whole caching layer — deliberately simple and entirely
   * client-side, matching the app's "nothing is stored server-side"
   * design (see the footer note): the cache just lives in this tab's
   * memory until the file is removed or the page is reloaded. */
  async function ensureConverted(entry) {
    if (entry.pdfBlob && entry.optionsSignature === currentOptionsSignature()) {
      return { blob: entry.pdfBlob, filename: entry.pdfFilename };
    }
    return convertFileToPdf(entry);
  }

  async function downloadSingleFile(id) {
    const entry = files.get(id);
    if (!entry) return;
    try {
      const { blob, filename } = await ensureConverted(entry);
      triggerBlobDownload(blob, filename);
      setStatus(`${entry.name} ready.`, "success");
      loadStats();
    } catch (err) {
      setStatus(`${entry.name}: ${err.message || "PDF generation failed."}`, "error");
    }
  }

  async function downloadAllZip() {
    const entries = Array.from(files.values());
    if (entries.length === 0) return;

    downloadAllBtn.disabled = true;
    downloadAllBtnLabel.textContent = "Converting…";

    let completed = 0;
    let failed = 0;
    setStatus(`Converting 0 of ${entries.length}…`);

    await runWithConcurrency(entries, MAX_CONCURRENT_CONVERSIONS, async (entry) => {
      try {
        await ensureConverted(entry);
      } catch (err) {
        failed += 1;
      } finally {
        completed += 1;
        setStatus(`Converting ${completed} of ${entries.length}…`);
      }
    });

    const ready = entries.filter((entry) => entry.status === "ready" && entry.pdfBlob);

    if (ready.length === 0) {
      setStatus("All conversions failed. Nothing to download.", "error");
      downloadAllBtnLabel.textContent = "Download all (.zip)";
      downloadAllBtn.disabled = files.size === 0;
      return;
    }

    downloadAllBtnLabel.textContent = "Zipping…";
    try {
      const zip = new JSZip();
      const usedNames = new Set();
      ready.forEach((entry) => {
        const base = entry.pdfFilename || entry.name.replace(/\.(md|markdown)$/i, "") + ".pdf";
        const name = dedupeName(base, usedNames);
        usedNames.add(name);
        zip.file(name, entry.pdfBlob);
      });

      const zipBlob = await zip.generateAsync({ type: "blob" });
      const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
      triggerBlobDownload(zipBlob, `markdown-to-pdf-${stamp}.zip`);

      if (failed > 0) {
        setStatus(`Downloaded ${ready.length} of ${entries.length} as ZIP (${failed} failed).`, "error");
      } else {
        setStatus(`Downloaded all ${ready.length} file${ready.length === 1 ? "" : "s"} as ZIP.`, "success");
      }
      loadStats();
    } catch (err) {
      setStatus("Could not build the ZIP file. Please try again.", "error");
    } finally {
      downloadAllBtnLabel.textContent = "Download all (.zip)";
      downloadAllBtn.disabled = files.size === 0;
    }
  }

  downloadAllBtn.addEventListener("click", downloadAllZip);

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
  // Custom dropdown (page size / margins)
  // ---------------------------------------------------------------------
  // A small reusable listbox-button pattern rather than a native <select>,
  // since a native select's popup can't be restyled to match the theme.
  // Keyboard support: Enter/Space opens, Arrow keys move, Enter/Space
  // selects, Escape closes. Menu *contents* are built by
  // buildAndWireOptionControls() below, from GET /api/page-options — the
  // backend's allowlist (app/page_options.py) is the single source of
  // truth for what's selectable here, so the two can never drift apart.
  function initDropdown(rootEl) {
    const trigger = rootEl.querySelector(".dropdown-trigger");
    const valueEl = trigger.querySelector(".dropdown-value");
    const menu = rootEl.querySelector(".dropdown-menu");
    const options = Array.from(menu.querySelectorAll('[role="option"]'));

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

    // `trigger` is a persistent element across repeated calls to
    // initDropdown() on the same root (buildAndWireOptionControls() calls
    // this once immediately with FALLBACK_PAGE_OPTIONS, then again once
    // the real /api/page-options response arrives) — only the menu's
    // <li> contents get thrown away and rebuilt each time, not the
    // trigger button itself. Without this cleanup, the second call adds
    // a *second* click listener alongside the first; one click then fires
    // both handlers, which independently check-and-toggle menu.hidden —
    // the first opens it, the second immediately sees it open and closes
    // it again, so nothing visibly happens on click at all.
    if (trigger._dropdownCleanup) trigger._dropdownCleanup();

    const onTriggerClick = () => {
      if (menu.hidden) open();
      else close();
    };
    trigger.addEventListener("click", onTriggerClick);

    trigger._dropdownCleanup = () => {
      trigger.removeEventListener("click", onTriggerClick);
      // In case a previous instance was left open (menu.hidden === false)
      // at the moment it got rebuilt, make sure its document/menu-level
      // listeners don't leak — they'd otherwise keep firing against a
      // <ul> whose children just got replaced out from under them.
      document.removeEventListener("click", onOutsideClick);
      menu.removeEventListener("keydown", onMenuKeydown);
    };

    options.forEach((option) => {
      option.addEventListener("click", () => select(option));
    });

    return {
      getValue: () =>
        (menu.querySelector('[aria-selected="true"]') || options[0]).dataset.value,
    };
  }

  function buildOptionLi(value, label, selected) {
    const li = document.createElement("li");
    li.setAttribute("role", "option");
    li.tabIndex = -1;
    li.dataset.value = value;
    li.textContent = label;
    if (selected) li.setAttribute("aria-selected", "true");
    return li;
  }

  function capitalize(word) {
    return word.charAt(0).toUpperCase() + word.slice(1);
  }

  /** (Re)builds the page-size and margins dropdown menus, and the font
   * stepper, from a /api/page-options-shaped object — called once
   * immediately with FALLBACK_PAGE_OPTIONS (so controls work right away)
   * and again once the real backend response arrives (see init() at the
   * bottom). Preserves whatever the person may have already picked, as
   * long as that value still exists in the new option set.
   *
   * Each of the three controls is wired independently, in its own
   * try/catch: if one throws (say, a stale cached app.js from before an
   * element was renamed, looking for an ID that no longer exists), the
   * other two still get built instead of all three going down together. */
  function buildAndWireOptionControls(meta) {
    try {
      wirePageSizeDropdown(meta);
    } catch (err) {
      console.error("Failed to build the page-size control:", err);
    }
    try {
      wireMarginsDropdown(meta);
    } catch (err) {
      console.error("Failed to build the margins control:", err);
    }
    try {
      initFontStepper(meta.font_size);
    } catch (err) {
      console.error("Failed to build the font-size control:", err);
    }
  }

  // Grouped with non-selectable headers (ISO A / B / C / Common) so a
  // 38-entry list stays scannable instead of one long alphabetical run.
  function wirePageSizeDropdown(meta) {
    const prevPageSize = pageSizeDropdown ? pageSizeDropdown.getValue() : meta.defaults.page_size;
    const pageSizeRoot = document.getElementById("pageSizeDropdown");
    const pageSizeMenu = pageSizeRoot.querySelector(".dropdown-menu");
    const pageSizeValueEl = pageSizeRoot.querySelector(".dropdown-value");
    const allPageSizes = meta.page_size_groups.flatMap((group) => group.sizes);
    const pageSizeValue = allPageSizes.includes(prevPageSize) ? prevPageSize : meta.defaults.page_size;

    pageSizeMenu.innerHTML = "";
    meta.page_size_groups.forEach((group) => {
      const groupLabel = document.createElement("li");
      groupLabel.className = "dropdown-group-label";
      groupLabel.setAttribute("role", "presentation");
      groupLabel.textContent = group.label;
      pageSizeMenu.appendChild(groupLabel);
      group.sizes.forEach((name) => {
        pageSizeMenu.appendChild(buildOptionLi(name, name, name === pageSizeValue));
      });
    });
    pageSizeValueEl.textContent = pageSizeValue;
    pageSizeDropdown = initDropdown(pageSizeRoot);
  }

  function wireMarginsDropdown(meta) {
    const prevMargins = marginsDropdown ? marginsDropdown.getValue() : meta.defaults.margins;
    const marginsRoot = document.getElementById("marginsDropdown");
    const marginsMenu = marginsRoot.querySelector(".dropdown-menu");
    const marginsValueEl = marginsRoot.querySelector(".dropdown-value");
    const marginsValue = meta.margins.includes(prevMargins) ? prevMargins : meta.defaults.margins;

    marginsMenu.innerHTML = "";
    meta.margins.forEach((name) => {
      marginsMenu.appendChild(buildOptionLi(name, capitalize(name), name === marginsValue));
    });
    marginsValueEl.textContent = capitalize(marginsValue);
    marginsDropdown = initDropdown(marginsRoot);
  }

  /** Font size uses a +/- stepper over a type-in number field rather than
   * a dropdown, since the backend now accepts any value in range (see
   * app/page_options.py) instead of a short fixed list — a dropdown with
   * 161 entries (8.0 to 24.0 in 0.1pt steps) would be unusable. +/- moves
   * by a full point per click for quick nudges; typing an exact value
   * (e.g. "13.7") still works and is what actually exercises the fine
   * 0.1pt grid. */
  function initFontStepper(fontMeta) {
    const input = document.getElementById("fontSizeInput");
    const decBtn = document.getElementById("fontSizeDecBtn");
    const incBtn = document.getElementById("fontSizeIncBtn");
    const { min, max, step, default: defaultValue } = fontMeta;

    input.min = String(min);
    input.max = String(max);
    input.step = String(step);

    function clamp(value) {
      return Math.min(max, Math.max(min, value));
    }
    function roundToStep(value) {
      // Always round to 1 decimal place regardless of `step`, since the
      // backend's grid (FONT_SIZE_STEP_PT) is 0.1 — finer than that isn't
      // meaningful for a point size anyway.
      return Math.round(value * 10) / 10;
    }
    function setValue(value) {
      const next = roundToStep(clamp(Number.isFinite(value) ? value : defaultValue));
      input.value = next.toFixed(1);
      return next;
    }

    // Carry over whatever value was already picked (relevant when this
    // runs a second time, upgrading from FALLBACK_PAGE_OPTIONS to the
    // real backend response) rather than resetting to the new default.
    const previousValue = fontSizeStepper ? fontSizeStepper.getValue() : defaultValue;
    setValue(previousValue);

    // Re-running this function rebinds the same persistent <input>/button
    // elements (they're never recreated), so tear down the previous
    // listeners first to avoid stacking duplicates.
    if (input._stepperCleanup) input._stepperCleanup();

    const onDec = () => setValue(parseFloat(input.value) - 1);
    const onInc = () => setValue(parseFloat(input.value) + 1);
    const onChange = () => setValue(parseFloat(input.value));

    decBtn.addEventListener("click", onDec);
    incBtn.addEventListener("click", onInc);
    input.addEventListener("change", onChange);

    input._stepperCleanup = () => {
      decBtn.removeEventListener("click", onDec);
      incBtn.removeEventListener("click", onInc);
      input.removeEventListener("change", onChange);
    };

    fontSizeStepper = { getValue: () => parseFloat(input.value) };
  }

  async function fetchPageOptions() {
    try {
      const response = await fetch("/api/page-options");
      if (!response.ok) return null;
      const data = await response.json();
      if (!data || !Array.isArray(data.page_size_groups) || !data.font_size) return null;
      return data;
    } catch (err) {
      return null; // offline / server hiccup — FALLBACK_PAGE_OPTIONS stands.
    }
  }

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
  async function init() {
    // Isolated from the rest of init(): if this throws for any reason (a
    // stale cached app.js paired with a newer index.html after a bad
    // deploy is the classic case — mismatched element IDs make this the
    // first thing to break), the whole app used to go down with it,
    // since nothing after an uncaught throw here would ever run. Now a
    // failure here only costs the page-size/margins/font controls;
    // downloading, uploading, and everything else still works.
    try {
      buildAndWireOptionControls(FALLBACK_PAGE_OPTIONS);
    } catch (err) {
      console.error("Failed to initialize page/margin/font controls:", err);
    }

    updateDownloadEnabled();
    renderPreviewNow();
    renderFilesList();
    loadStats();
    loadQuote();

    try {
      const meta = await fetchPageOptions();
      if (meta) buildAndWireOptionControls(meta);
    } catch (err) {
      console.error("Failed to upgrade page options from /api/page-options:", err);
    }
  }

  init();
})();
