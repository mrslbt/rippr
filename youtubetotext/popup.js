(function () {
  const urlInput = document.getElementById("url-input");
  const pasteBtn = document.getElementById("paste-btn");
  const ripBtn = document.getElementById("rip-btn");
  const ripBtnText = ripBtn.querySelector(".rip-btn-text");
  const statusMsg = document.getElementById("status-msg");
  const chips = document.querySelectorAll(".preset-chip");

  let selectedFormat = "txt";

  // ── Update button state ────────────────────────────────
  function updateButtonState() {
    const videoId = rippr.extractVideoId(urlInput.value);
    if (videoId) {
      ripBtn.disabled = false;
      ripBtnText.textContent = "RIP TRANSCRIPT";
    } else if (urlInput.value.trim()) {
      ripBtn.disabled = true;
      ripBtnText.textContent = "Invalid URL";
    } else {
      ripBtn.disabled = true;
      ripBtnText.textContent = "Paste a URL to start";
    }
  }

  // ── Set status message ─────────────────────────────────
  function setStatus(text, type = "") {
    statusMsg.textContent = text;
    statusMsg.className = "status-msg" + (type ? " " + type : "");
  }

  // ── Handle rip ─────────────────────────────────────────
  async function handleRip() {
    const videoId = rippr.extractVideoId(urlInput.value);
    if (!videoId) return;

    // Loading state
    ripBtn.classList.add("loading");
    ripBtn.disabled = true;
    ripBtn.classList.remove("success", "error");
    setStatus("Ripping transcript...");

    try {
      const response = await chrome.runtime.sendMessage({
        action: "fetchTranscript",
        videoId: videoId,
      });

      if (!response.success) {
        throw new Error(response.error || "Unknown error");
      }

      const data = response.data;

      // Show auto-generated caption warning
      const isAuto = data.tracks && data.tracks.some((t) => t.isAuto && t.lang === data.language);
      const output = rippr.buildOutput(data, selectedFormat);
      const safeName = rippr.sanitizeFilename(data.title);
      const filename = `${safeName}.${selectedFormat}`;

      rippr.downloadFile(output, filename);

      // Success state
      ripBtn.classList.remove("loading");
      ripBtn.classList.add("success");
      ripBtnText.textContent = "DONE!";
      const autoNote = isAuto ? " (auto-generated)" : "";
      setStatus(
        `${data.segments.length} segments saved as ${filename}${autoNote}`,
        "success"
      );

      // Reset after 3s
      setTimeout(() => {
        ripBtn.classList.remove("success");
        updateButtonState();
        setStatus("");
      }, 3000);
    } catch (err) {
      ripBtn.classList.remove("loading");
      ripBtn.classList.add("error");
      ripBtnText.textContent = "FAILED";
      setStatus(err.message, "error");

      setTimeout(() => {
        ripBtn.classList.remove("error");
        updateButtonState();
      }, 3000);
    }
  }

  // ── Event listeners ────────────────────────────────────

  urlInput.addEventListener("input", updateButtonState);

  urlInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !ripBtn.disabled) {
      handleRip();
    }
  });

  pasteBtn.addEventListener("click", async () => {
    try {
      const text = await navigator.clipboard.readText();
      urlInput.value = text;
      updateButtonState();
      const videoId = rippr.extractVideoId(text);
      if (videoId) handleRip();
    } catch {
      urlInput.focus();
    }
  });

  ripBtn.addEventListener("click", handleRip);

  // Preset selection
  chips.forEach((el) => {
    el.addEventListener("click", () => {
      chips.forEach((p) => {
        p.classList.remove("active");
        const badge = p.querySelector(".chip-badge");
        if (badge) { badge.textContent = ""; badge.style.display = "none"; }
      });
      el.classList.add("active");
      let badge = el.querySelector(".chip-badge");
      if (!badge) {
        badge = document.createElement("span");
        badge.className = "chip-badge";
        el.appendChild(badge);
      }
      badge.textContent = "selected";
      badge.style.display = "";
      selectedFormat = el.dataset.format;
    });
  });

  // Auto-detect if user is on a YouTube page
  if (typeof chrome !== "undefined" && chrome.tabs) {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      if (tab && tab.url) {
        const videoId = rippr.extractVideoId(tab.url);
        if (videoId) {
          urlInput.value = tab.url;
          updateButtonState();
          setStatus("YouTube video detected — hit RIP!", "success");
        }
      }
    });
  }

  // Focus input on open
  setTimeout(() => urlInput.focus(), 100);
})();
