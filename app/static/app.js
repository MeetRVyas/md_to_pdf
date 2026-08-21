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
    } catch (err) {
      setStatus("The server is temporarily unavailable.", "error");
    } finally {
      downloadBtn.disabled = !editor.value.trim();
      downloadBtnLabel.textContent = "Download PDF";
    }
  }

  downloadBtn.addEventListener("click", downloadPdf);

  // ---------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------
  updateDownloadEnabled();
  renderPreviewNow();
})();
