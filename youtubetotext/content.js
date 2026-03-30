(function () {
  "use strict";

  const BUTTON_ID = "rippr-btn";
  const MENU_ID = "rippr-menu";

  let currentVideoId = null;

  // ── Pixel art mascot SVG (inline, tiny) ────────────────
  const MASCOT_IMG = `<img class="rippr-mascot-inline" src="${chrome.runtime.getURL("icons/icon48.png")}" width="18" height="18" alt="rippr" />`;

  // ── Page utilities ──────────────────────────────────────

  function getVideoId() {
    const params = new URLSearchParams(window.location.search);
    return params.get("v");
  }

  function getVideoTitle() {
    const el =
      document.querySelector(
        "yt-formatted-string.style-scope.ytd-watch-metadata"
      ) ||
      document.querySelector("h1.ytd-watch-metadata yt-formatted-string") ||
      document.querySelector("#title h1 yt-formatted-string");
    return el ? el.textContent.trim() : document.title.replace(" - YouTube", "").trim();
  }

  function getChannelName() {
    const el =
      document.querySelector("#owner #channel-name a") ||
      document.querySelector("ytd-channel-name a");
    return el ? el.textContent.trim() : "Unknown Channel";
  }

  function getVideoDate() {
    const el = document.querySelector("#info-strings yt-formatted-string");
    return el ? el.textContent.trim() : "";
  }

  // ── Extract YouTube page config ────────────────────────

  function getYtConfig() {
    const id = "rippr-cfg-" + Date.now();
    const el = document.createElement("div");
    el.id = id;
    el.style.display = "none";
    document.body.appendChild(el);

    const script = document.createElement("script");
    script.textContent = `
      try {
        var cfg = typeof ytcfg !== 'undefined' ? ytcfg.data_ || ytcfg : {};
        document.getElementById("${id}").textContent = JSON.stringify({
          apiKey: cfg.INNERTUBE_API_KEY || "",
          clientName: cfg.INNERTUBE_CLIENT_NAME || "WEB",
          clientVersion: cfg.INNERTUBE_CLIENT_VERSION || "2.20240101.00.00",
          visitorData: cfg.VISITOR_DATA || ""
        });
      } catch(e) {
        document.getElementById("${id}").textContent = "ERROR";
      }
    `;
    document.body.appendChild(script);
    script.remove();

    const raw = el.textContent;
    el.remove();

    if (raw && raw !== "ERROR") {
      try { return JSON.parse(raw); } catch { /* fall through */ }
    }

    // No hardcoded API key fallback — return what we have
    return {
      apiKey: "",
      clientName: "WEB",
      clientVersion: "2.20240101.00.00",
      visitorData: ""
    };
  }

  // ── Transcript Extraction via Innertube ────────────────

  async function fetchTranscriptViaInnertube(videoId) {
    const cfg = getYtConfig();

    if (!cfg.apiKey) {
      throw new Error("Could not read YouTube page config. Try refreshing the page.");
    }

    const playerUrl = `https://www.youtube.com/youtubei/v1/player?key=${cfg.apiKey}&prettyPrint=false`;
    const playerBody = {
      context: {
        client: {
          hl: "en",
          gl: "US",
          clientName: "WEB",
          clientVersion: cfg.clientVersion,
          ...(cfg.visitorData ? { visitorData: cfg.visitorData } : {})
        }
      },
      videoId: videoId
    };

    const playerResp = await fetch(playerUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(playerBody)
    });

    if (!playerResp.ok) {
      throw new Error("Failed to fetch video data from YouTube.");
    }

    const playerData = await playerResp.json();

    const captionTracks =
      playerData?.captions?.playerCaptionsTracklistRenderer?.captionTracks;

    if (!captionTracks || captionTracks.length === 0) {
      throw new Error(
        "No captions available for this video. It may not have subtitles enabled."
      );
    }

    return { captionTracks, playerData, cfg };
  }

  async function fetchCaptionContent(captionTrack) {
    const baseUrl = captionTrack.baseUrl;

    // Try fetching the caption URL directly (XML format)
    try {
      const resp = await fetch(baseUrl);
      if (resp.ok) {
        const text = await resp.text();
        if (text.includes("<text") && !text.includes("<!DOCTYPE html")) {
          return rippr.parseXmlCaptions(text);
        }
      }
    } catch { /* continue */ }

    // Try with explicit XML format
    try {
      const separator = baseUrl.includes("?") ? "&" : "?";
      const resp = await fetch(baseUrl + separator + "fmt=srv3");
      if (resp.ok) {
        const text = await resp.text();
        if (text.includes("<text") || text.includes("<p ")) {
          return rippr.parseXmlCaptions(text);
        }
      }
    } catch { /* continue */ }

    // Try JSON3
    try {
      const separator = baseUrl.includes("?") ? "&" : "?";
      const resp = await fetch(baseUrl + separator + "fmt=json3");
      if (resp.ok) {
        const text = await resp.text();
        if (text.trim().startsWith("{")) {
          const data = JSON.parse(text);
          if (data.events) return data.events;
        }
      }
    } catch { /* continue */ }

    return null;
  }

  // ── Scrape transcript panel as ultimate fallback ───────

  async function scrapeTranscriptPanel() {
    const moreBtn = document.querySelector(
      '#actions ytd-menu-renderer button[aria-label="More actions"], ' +
      'ytd-menu-renderer.ytd-watch-metadata yt-icon-button'
    );

    if (!moreBtn) return null;

    moreBtn.click();

    // Wait for menu items to appear instead of fixed timeout
    try {
      await waitForElement(
        "ytd-menu-service-item-renderer, tp-yt-paper-listbox ytd-menu-service-item-renderer",
        3000
      );
    } catch {
      return null;
    }

    const menuItems = document.querySelectorAll(
      "ytd-menu-service-item-renderer, tp-yt-paper-listbox ytd-menu-service-item-renderer"
    );
    let transcriptBtn = null;
    for (const item of menuItems) {
      if (item.textContent.toLowerCase().includes("transcript")) {
        transcriptBtn = item;
        break;
      }
    }

    if (!transcriptBtn) {
      document.body.click();
      return null;
    }

    transcriptBtn.click();

    // Wait for transcript segments to appear instead of fixed timeout
    try {
      await waitForElement(
        "ytd-transcript-segment-renderer, ytd-transcript-segment-list-renderer ytd-transcript-segment-renderer",
        5000
      );
    } catch {
      return null;
    }

    const segmentEls = document.querySelectorAll(
      "ytd-transcript-segment-renderer, " +
      "ytd-transcript-segment-list-renderer ytd-transcript-segment-renderer"
    );

    if (segmentEls.length === 0) return null;

    const segments = [];
    segmentEls.forEach((seg) => {
      const timeEl = seg.querySelector(
        ".segment-timestamp, [class*='timestamp']"
      );
      const textEl = seg.querySelector(
        ".segment-text, yt-formatted-string[class*='segment-text']"
      );

      const timeStr = timeEl ? timeEl.textContent.trim() : "0:00";
      const text = textEl ? textEl.textContent.trim() : "";

      const parts = timeStr.split(":").map(Number);
      let totalSecs = 0;
      if (parts.length === 3) totalSecs = parts[0] * 3600 + parts[1] * 60 + parts[2];
      else if (parts.length === 2) totalSecs = parts[0] * 60 + parts[1];
      else totalSecs = parts[0] || 0;

      if (text) {
        segments.push({
          startMs: Math.round(totalSecs * 1000),
          durationMs: 0,
          text: text,
        });
      }
    });

    const closeBtn = document.querySelector(
      "ytd-engagement-panel-section-list-renderer button[aria-label='Close']," +
      "ytd-engagement-panel-title-header-renderer #visibility-button button"
    );
    if (closeBtn) closeBtn.click();

    return segments.length > 0 ? segments : null;
  }

  // ── Main download flow ─────────────────────────────────

  async function handleDownload(selectedLang, options = {}) {
    const { includeTimestamps = false, format = "txt" } = options;
    const videoId = getVideoId();
    if (!videoId) throw new Error("No video ID found.");

    let segments = null;
    let langCode = "en";

    // Strategy 1: Innertube API -> caption URL -> fetch
    try {
      const { captionTracks } = await fetchTranscriptViaInnertube(videoId);
      const track = captionTracks[selectedLang] || captionTracks[0];
      langCode = track.languageCode || "en";

      const result = await fetchCaptionContent(track);
      if (result && result.length > 0) {
        if (result[0].segs) {
          segments = result.map((ev) => ({
            startMs: ev.tStartMs || 0,
            durationMs: ev.dDurationMs || 0,
            text: (ev.segs || []).map((s) => s.utf8 || "").join("").trim(),
          })).filter((s) => s.text);
        } else {
          segments = result;
        }
      }
    } catch (err) {
      console.warn("[rippr] Innertube caption fetch failed:", err.message);
    }

    // Strategy 2: Background service worker (ANDROID client)
    if (!segments || segments.length === 0) {
      try {
        const bgData = await fetchViaBackground(videoId);
        if (bgData.segments && bgData.segments.length > 0) {
          langCode = bgData.language || "en";
          segments = bgData.segments.map((s) => ({
            startMs: Math.round(s.start * 1000),
            durationMs: Math.round(s.duration * 1000),
            text: s.text,
          }));
        }
      } catch (err) {
        console.warn("[rippr] Background worker failed:", err.message);
      }
    }

    // Strategy 3: Scrape YouTube's own transcript panel
    if (!segments || segments.length === 0) {
      try {
        segments = await scrapeTranscriptPanel();
      } catch (err) {
        console.warn("[rippr] Panel scrape failed:", err.message);
      }
    }

    if (!segments || segments.length === 0) {
      throw new Error(
        "Could not get transcript. This video may not have captions available."
      );
    }

    // Build output using shared utility
    const title = getVideoTitle();
    const channel = getChannelName();
    const date = getVideoDate();
    const videoUrl = window.location.href;

    const output = rippr.buildOutput(
      { title, channel, date, url: videoUrl, language: langCode, segments },
      format,
      includeTimestamps
    );

    const filename = `${rippr.sanitizeFilename(title)}.${format}`;
    rippr.downloadFile(output, filename);

    return filename;
  }

  // ── Fetch via background service worker (fallback) ─────

  async function fetchViaBackground(videoId) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        { action: "fetchTranscript", videoId },
        (response) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else if (!response.success) {
            reject(new Error(response.error));
          } else {
            resolve(response.data);
          }
        }
      );
    });
  }

  // ── Get available languages ────────────────────────────

  async function getAvailableTracks() {
    const videoId = getVideoId();
    if (!videoId) throw new Error("Not on a YouTube video page.");

    // Try content script Innertube first, fall back to background worker
    try {
      const { captionTracks } = await fetchTranscriptViaInnertube(videoId);
      return captionTracks;
    } catch (e) {
      console.warn("[rippr] Content script Innertube failed:", e.message, "— using background worker");
      const data = await fetchViaBackground(videoId);
      return data.tracks.map((t) => ({
        languageCode: t.lang,
        name: { simpleText: t.name },
        kind: t.isAuto ? "asr" : "",
        baseUrl: "", // Not needed — download will go through background
      }));
    }
  }

  // ── UI ───────────────────────────────────────────────────

  function createButton() {
    if (document.getElementById(BUTTON_ID)) return;

    const btn = document.createElement("button");
    btn.id = BUTTON_ID;
    btn.innerHTML = `${MASCOT_IMG}<span>rippr</span>`;
    btn.addEventListener("click", handleButtonClick);

    waitForElement("#owner, #above-the-fold #top-row").then((anchor) => {
      const container =
        document.querySelector(
          "#top-row #actions, #menu-container, #actions-inner"
        ) || anchor;
      if (container && !document.getElementById(BUTTON_ID)) {
        container.appendChild(btn);
      }
    });
  }

  function createMenu(captionTracks) {
    removeMenu();

    const menu = document.createElement("div");
    menu.id = MENU_ID;

    // Header
    const header = document.createElement("div");
    header.className = "rippr-menu-header";
    header.innerHTML = `${MASCOT_IMG} Download Transcript`;
    menu.appendChild(header);

    // Language selector
    if (captionTracks.length > 1) {
      const langGroup = document.createElement("div");
      langGroup.className = "rippr-menu-group";

      const langLabel = document.createElement("label");
      langLabel.textContent = "Language";
      langLabel.className = "rippr-label";
      langGroup.appendChild(langLabel);

      const langSelect = document.createElement("select");
      langSelect.id = "rippr-lang-select";
      langSelect.className = "rippr-select";
      captionTracks.forEach((track, i) => {
        const opt = document.createElement("option");
        opt.value = i;
        const name = track.name?.simpleText || track.languageCode;
        const autoTag = track.kind === "asr" ? " (auto-generated)" : "";
        opt.textContent = `${name}${autoTag}`;
        langSelect.appendChild(opt);
      });
      langGroup.appendChild(langSelect);
      menu.appendChild(langGroup);
    }

    // Auto-generated caption notice
    const primaryTrack = captionTracks[0];
    if (primaryTrack && primaryTrack.kind === "asr") {
      const notice = document.createElement("div");
      notice.className = "rippr-auto-notice";
      notice.textContent = "Auto-generated captions may contain errors";
      menu.appendChild(notice);
    }

    // Format chips
    const fmtGroup = document.createElement("div");
    fmtGroup.className = "rippr-menu-group";

    const fmtLabel = document.createElement("label");
    fmtLabel.textContent = "Format";
    fmtLabel.className = "rippr-label";
    fmtGroup.appendChild(fmtLabel);

    const chipContainer = document.createElement("div");
    chipContainer.className = "rippr-format-chips";

    [
      { value: "txt", label: "RAG (.txt)" },
      { value: "json", label: "JSON" },
      { value: "md", label: "Markdown" },
    ].forEach(({ value, label }, i) => {
      const chip = document.createElement("button");
      chip.className = `rippr-chip${i === 0 ? " active" : ""}`;
      chip.dataset.format = value;
      chip.textContent = label;
      chip.addEventListener("click", () => {
        chipContainer.querySelectorAll(".rippr-chip").forEach((c) => c.classList.remove("active"));
        chip.classList.add("active");
      });
      chipContainer.appendChild(chip);
    });

    fmtGroup.appendChild(chipContainer);
    menu.appendChild(fmtGroup);

    // Timestamps toggle
    const tsGroup = document.createElement("div");
    tsGroup.className = "rippr-toggle-group";

    const toggle = document.createElement("label");
    toggle.className = "rippr-toggle";

    const tsCheckbox = document.createElement("input");
    tsCheckbox.type = "checkbox";
    tsCheckbox.id = "rippr-timestamps";

    const track = document.createElement("span");
    track.className = "rippr-toggle-track";

    toggle.appendChild(tsCheckbox);
    toggle.appendChild(track);
    tsGroup.appendChild(toggle);

    const tsLabel = document.createElement("span");
    tsLabel.className = "rippr-toggle-label";
    tsLabel.textContent = "Include timestamps";
    tsLabel.style.cursor = "pointer";
    tsLabel.addEventListener("click", () => { tsCheckbox.checked = !tsCheckbox.checked; });
    tsGroup.appendChild(tsLabel);
    menu.appendChild(tsGroup);

    // Download button
    const dlBtn = document.createElement("button");
    dlBtn.className = "rippr-download-action";
    dlBtn.textContent = "Download";
    dlBtn.addEventListener("click", async () => {
      const langIndex = parseInt(
        document.getElementById("rippr-lang-select")?.value || "0", 10
      );
      const activeChip = chipContainer.querySelector(".rippr-chip.active");
      const format = activeChip?.dataset.format || "txt";
      const includeTimestamps =
        document.getElementById("rippr-timestamps").checked;

      dlBtn.textContent = "Ripping...";
      dlBtn.disabled = true;

      try {
        const filename = await handleDownload(langIndex, {
          includeTimestamps,
          format,
        });
        dlBtn.textContent = "Done!";
        dlBtn.classList.add("success");
        showToast(`Saved: ${filename}`, true);
        setTimeout(() => removeMenu(), 1500);
      } catch (err) {
        dlBtn.textContent = "Error — try again";
        dlBtn.disabled = false;
        showToast(err.message);
        console.error("[rippr]", err);
      }
    });
    menu.appendChild(dlBtn);

    // Close on outside click
    setTimeout(() => {
      document.addEventListener("click", handleOutsideClick);
    }, 100);

    // Position near button
    const btn = document.getElementById(BUTTON_ID);
    if (btn) {
      btn.parentElement.style.position = "relative";
      btn.parentElement.appendChild(menu);
    } else {
      document.body.appendChild(menu);
    }
  }

  function removeMenu() {
    const menu = document.getElementById(MENU_ID);
    if (menu) menu.remove();
    document.removeEventListener("click", handleOutsideClick);
  }

  function handleOutsideClick(e) {
    const menu = document.getElementById(MENU_ID);
    const btn = document.getElementById(BUTTON_ID);
    if (menu && !menu.contains(e.target) && e.target !== btn && !btn.contains(e.target)) {
      removeMenu();
    }
  }

  async function handleButtonClick(e) {
    e.stopPropagation();

    const existingMenu = document.getElementById(MENU_ID);
    if (existingMenu) {
      removeMenu();
      return;
    }

    const btn = document.getElementById(BUTTON_ID);
    btn.classList.add("rippr-loading");

    try {
      const tracks = await getAvailableTracks();
      createMenu(tracks);
    } catch (err) {
      showToast(err.message);
      console.error("[rippr]", err);
    } finally {
      btn.classList.remove("rippr-loading");
    }
  }

  function showToast(message, isSuccess = false) {
    const existing = document.querySelector(".rippr-toast");
    if (existing) existing.remove();

    const toast = document.createElement("div");
    toast.className = `rippr-toast${isSuccess ? " success" : ""}`;
    toast.textContent = message;
    document.body.appendChild(toast);

    setTimeout(() => toast.classList.add("rippr-toast-visible"), 10);
    setTimeout(() => {
      toast.classList.remove("rippr-toast-visible");
      setTimeout(() => toast.remove(), 300);
    }, 4000);
  }

  // ── Helpers ──────────────────────────────────────────────

  function waitForElement(selector, timeout = 10000) {
    return new Promise((resolve, reject) => {
      const el = document.querySelector(selector);
      if (el) return resolve(el);

      const observer = new MutationObserver(() => {
        const el = document.querySelector(selector);
        if (el) {
          observer.disconnect();
          resolve(el);
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });

      setTimeout(() => {
        observer.disconnect();
        reject(new Error("Timed out waiting for element: " + selector));
      }, timeout);
    });
  }

  // ── SPA Navigation Handling ──────────────────────────────

  function onNavigate() {
    const videoId = getVideoId();
    if (!videoId) return;
    if (videoId === currentVideoId) return;
    currentVideoId = videoId;

    const oldBtn = document.getElementById(BUTTON_ID);
    if (oldBtn) oldBtn.remove();
    removeMenu();

    createButton();
  }

  const pushState = history.pushState;
  history.pushState = function () {
    pushState.apply(this, arguments);
    setTimeout(onNavigate, 200);
  };

  window.addEventListener("popstate", () => setTimeout(onNavigate, 200));
  window.addEventListener("yt-navigate-finish", onNavigate);

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", onNavigate);
  } else {
    onNavigate();
  }
})();
