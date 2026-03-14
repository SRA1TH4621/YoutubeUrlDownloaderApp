const urlInput = document.getElementById("urlInput");
const fetchBtn = document.getElementById("fetchBtn");
const statusText = document.getElementById("statusText");
const thumb = document.getElementById("thumb");
const titleText = document.getElementById("titleText");
const durationText = document.getElementById("durationText");
const formatsEl = document.getElementById("formats");
const progressFill = document.getElementById("progressFill");
const progressPct = document.getElementById("progressPct");
const downloadLink = document.getElementById("downloadLink");
const progressMeta = document.getElementById("progressMeta");
const previewFrame = document.getElementById("previewFrame");
const thumbLoading = document.getElementById("thumbLoading");
const previewNote = document.getElementById("previewNote");
const titleDefault = titleText.textContent;

let pasteTimer = null;
let latestInfo = null;
let ws = null;
let downloadStart = null;
let lastSpeed = null;
let lastEta = null;

function setStatus(text, isError) {
  statusText.textContent = text;
  statusText.style.color = isError ? "#ff5c7c" : "#94a3b8";
}

function setProgress(value) {
  const pct = Math.max(0, Math.min(100, Math.round(value)));
  progressFill.style.width = `${pct}%`;
  progressPct.textContent = `${pct}%`;
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "--";
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  if (mins <= 0) return `${secs}s`;
  return `${mins}m ${secs}s`;
}

function updateTimeMeta(percent) {
  if (!downloadStart || percent <= 0) {
    progressMeta.textContent = "Speed: --  |  Remaining: --";
    return;
  }
  let remainingLabel = "--";
  if (lastEta) {
    remainingLabel = lastEta;
  } else {
    const elapsed = (Date.now() - downloadStart) / 1000;
    const totalEstimate = (elapsed / percent) * 100;
    const remaining = Math.max(0, totalEstimate - elapsed);
    remainingLabel = formatTime(remaining);
  }
  const speedLabel = lastSpeed || "--";
  progressMeta.textContent = `Speed: ${speedLabel}  |  Remaining: ${remainingLabel}`;
}

function formatDuration(seconds) {
  if (!seconds) return "";
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}m ${secs}s`;
}

function connectWs() {
  if (ws && ws.readyState === WebSocket.OPEN) return;
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}`);
}

async function fetchInfo() {
  const url = urlInput.value.trim();
  if (!url) return;
  setStatus("Detecting formats...", false);
  fetchBtn.disabled = true;
  downloadLink.textContent = "";
  setProgress(0);
  progressMeta.textContent = "Speed: --  |  Remaining: --";
  thumbLoading.style.display = "block";
  previewFrame.style.display = "none";
  thumb.style.display = "none";
  previewNote.style.display = "none";
  titleText.textContent = "Loading...";

  try {
    const res = await fetch("/api/info", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || "Failed to detect");
    }

    const data = await res.json();
    latestInfo = data;

    titleText.textContent = data.title || "Unknown title";
    durationText.textContent = data.duration
      ? `Duration: ${formatDuration(data.duration)}`
      : "";
    if (data.embedUrl) {
      previewFrame.src = data.embedUrl;
      previewFrame.style.display = "block";
      thumb.style.display = "none";
      previewNote.style.display = "none";
    } else if (data.thumbnail) {
      thumb.src = data.thumbnail;
      thumb.style.display = "block";
      previewNote.style.display = "block";
    } else {
      previewNote.style.display = "block";
    }
    thumbLoading.style.display = "none";

    renderFormats(data.formats || []);
    setStatus("Formats ready. Select a resolution or MP3.", false);
  } catch (err) {
    setStatus(err.message, true);
    thumbLoading.style.display = "none";
    previewNote.style.display = "block";
    titleText.textContent = titleDefault;
  } finally {
    fetchBtn.disabled = false;
  }
}

function renderFormats(formats) {
  formatsEl.innerHTML = "";
  if (formats.length === 0) {
    formatsEl.textContent = "No formats detected.";
    return;
  }

  for (const f of formats) {
    const btn = document.createElement("button");
    btn.className = "format-btn";
    const sizeLabel = f.sizeMb ? ` (${f.sizeMb})` : "";
    btn.textContent = `${f.label}${sizeLabel}`;
    if (f.sizeMb) {
      btn.title = "Size in MB (bytes / 1024 / 1024)";
    }
    btn.addEventListener("click", () => startDownload(f));
    formatsEl.appendChild(btn);
  }

  const mp3Bitrates = [128, 192, 320];
  for (const rate of mp3Bitrates) {
    const mp3 = document.createElement("button");
    mp3.className = "format-btn mp3";
    mp3.textContent = `MP3 ${rate}kbps`;
    mp3.addEventListener("click", () =>
      startDownload({ isMp3: true, audioBitrate: rate })
    );
    formatsEl.appendChild(mp3);
  }
}

async function startDownload(format) {
  if (!latestInfo) return;
  connectWs();
  setProgress(0);
  setStatus("Starting download...", false);
  downloadLink.textContent = "";
  progressMeta.textContent = "Speed: --  |  Remaining: --";
  downloadStart = Date.now();
  lastSpeed = null;
  lastEta = null;

  const payload = {
    url: urlInput.value.trim(),
    formatId: format.formatId,
    hasAudio: format.hasAudio,
    isMp3: format.isMp3 || false,
    audioBitrate: format.audioBitrate || null,
    title: latestInfo.title || "video",
  };

  try {
    const res = await fetch("/api/download", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || "Download failed");
    }

    const data = await res.json();
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "subscribe", jobId: data.jobId }));
    } else {
      ws.addEventListener("open", () => {
        ws.send(JSON.stringify({ type: "subscribe", jobId: data.jobId }));
      });
    }
  } catch (err) {
    setStatus(err.message, true);
  }
}

fetchBtn.addEventListener("click", fetchInfo);

urlInput.addEventListener("paste", () => {
  clearTimeout(pasteTimer);
  pasteTimer = setTimeout(fetchInfo, 300);
});

urlInput.addEventListener("input", () => {
  clearTimeout(pasteTimer);
  pasteTimer = setTimeout(fetchInfo, 600);
});

connectWs();

if (ws) {
  ws.addEventListener("message", (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    if (msg.type === "progress") {
      setProgress(msg.percent);
      setStatus(`Downloading... ${Math.round(msg.percent)}%`, false);
      if (msg.speed) lastSpeed = msg.speed;
      if (msg.eta) lastEta = msg.eta;
      updateTimeMeta(msg.percent);
    }
    if (msg.type === "done") {
      setProgress(100);
      setStatus("Download complete.", false);
      progressMeta.textContent = "Speed: --  |  Remaining: 0s";
      const link = document.createElement("a");
      link.href = msg.downloadUrl;
      link.textContent = `Download ${msg.filename}`;
      link.setAttribute("download", msg.filename);
      downloadLink.innerHTML = "";
      downloadLink.appendChild(link);
      link.click();
    }
    if (msg.type === "error") {
      setStatus("Download failed. Check server logs.", true);
      progressMeta.textContent = "Speed: --  |  Remaining: --";
    }
  });
}
