const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const express = require("express");
const http = require("http");
const WebSocket = require("ws");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;
const DOWNLOAD_DIR = path.join(__dirname, "..", "downloads");

const jobs = new Map(); // jobId -> { path, ext, title, status }
const wsSubscribers = new Map(); // jobId -> Set(ws)

if (!fs.existsSync(DOWNLOAD_DIR)) {
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
}

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "..", "client")));

function safeAsciiFilename(input) {
  const base = (input || "video")
    .replace(/[^\x20-\x7E]+/g, "")
    .replace(/[\s]+/g, " ")
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "")
    .trim();
  return base.length > 0 ? base.slice(0, 80) : "video";
}

function sendProgress(jobId, payload) {
  const subs = wsSubscribers.get(jobId);
  if (!subs) return;
  const data = JSON.stringify(payload);
  for (const ws of subs) {
    if (ws.readyState === WebSocket.OPEN) ws.send(data);
  }
}

function parseProgress(line) {
  const percentMatch = line.match(/(\d+(?:\.\d+)?)%/);
  const speedMatch = line.match(/at\s+([0-9.]+\s*[KMG]i?B\/s)/i);
  const etaMatch = line.match(/ETA\s+([0-9:]+)/i);

  let percent = null;
  if (percentMatch) {
    const value = Number(percentMatch[1]);
    if (!Number.isNaN(value)) {
      percent = Math.max(0, Math.min(100, value));
    }
  }

  return {
    percent,
    speed: speedMatch ? speedMatch[1].replace(/\s+/g, " ") : null,
    eta: etaMatch ? etaMatch[1] : null,
  };
}

function mapFormats(info) {
  const wanted = [360, 480, 720, 1080, 1440, 2160, 4320];
  const formats = info.formats || [];

  const pickByHeight = (height) => {
    const candidates = formats.filter(
      (f) =>
        f.height === height &&
        f.vcodec &&
        f.vcodec !== "none" &&
        f.filesize !== 0
    );
    if (candidates.length === 0) return null;
    const sorted = candidates.sort((a, b) => {
      const brA = a.tbr || 0;
      const brB = b.tbr || 0;
      const extA = a.ext === "mp4" ? 1 : 0;
      const extB = b.ext === "mp4" ? 1 : 0;
      return brB - brA || extB - extA;
    });
    return sorted[0];
  };

  const results = [];
  for (const h of wanted) {
    const fmt = pickByHeight(h);
    if (!fmt) continue;
    const sizeBytes = fmt.filesize || fmt.filesize_approx || 0;
    const sizeMb = sizeBytes
      ? `${(sizeBytes / 1024 / 1024).toFixed(2)} MB`
      : "";
    results.push({
      height: h,
      label: h >= 2160 ? `${h / 1080}K` : `${h}p`,
      formatId: fmt.format_id,
      ext: fmt.ext || "mp4",
      hasAudio: fmt.acodec && fmt.acodec !== "none",
      sizeMb,
    });
  }

  return results;
}

app.post("/api/info", (req, res) => {
  const url = String(req.body?.url || "").trim();
  if (!url) return res.status(400).json({ error: "Missing URL" });

  const args = ["-J", "--no-playlist", url];
  const proc = spawn("yt-dlp", args);
  let responded = false;

  let out = "";
  let err = "";
  proc.stdout.on("data", (d) => (out += d.toString("utf8")));
  proc.stderr.on("data", (d) => (err += d.toString("utf8")));

  proc.on("error", (spawnErr) => {
    if (responded) return;
    responded = true;
    console.error("yt-dlp spawn error (info):", spawnErr);
    if (spawnErr && spawnErr.code === "ENOENT") {
      return res.status(500).json({
        error: "yt-dlp not found",
        details: "Install yt-dlp and ensure it is available in PATH.",
      });
    }
    return res.status(500).json({
      error: "Failed to start yt-dlp",
      details: spawnErr?.message || "Unknown spawn error",
    });
  });

  proc.on("close", (code) => {
    if (responded) return;
    if (code !== 0) {
      responded = true;
      console.error("yt-dlp info error:", err.trim());
      return res.status(500).json({
        error: "Failed to fetch info",
        details: err.trim() || "yt-dlp error",
      });
    }
    try {
      const info = JSON.parse(out);
      const formats = mapFormats(info);
      const extractor = String(info.extractor_key || info.extractor || "")
        .toLowerCase()
        .trim();
      const isYouTube = extractor.includes("youtube");
      responded = true;
      res.json({
        id: info.id,
        title: info.title,
        thumbnail: info.thumbnail,
        duration: info.duration,
        embedUrl:
          isYouTube && info.id
            ? `https://www.youtube.com/embed/${info.id}`
            : null,
        sourceUrl: info.webpage_url || null,
        formats,
      });
    } catch (e) {
      responded = true;
      console.error("yt-dlp info parse error:", e);
      res.status(500).json({ error: "Invalid yt-dlp response" });
    }
  });
});

app.post("/api/download", (req, res) => {
  const url = String(req.body?.url || "").trim();
  const formatId = String(req.body?.formatId || "").trim();
  const hasAudio = Boolean(req.body?.hasAudio);
  const isMp3 = Boolean(req.body?.isMp3);
  const audioBitrateRaw = req.body?.audioBitrate;
  const audioBitrate = [128, 192, 320].includes(Number(audioBitrateRaw))
    ? Number(audioBitrateRaw)
    : null;
  const title = safeAsciiFilename(String(req.body?.title || "video"));

  if (!url) return res.status(400).json({ error: "Missing URL" });
  if (!isMp3 && !formatId) {
    return res.status(400).json({ error: "Missing format" });
  }

  const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const ext = isMp3 ? "mp3" : "mp4";
  const outTemplate = path.join(DOWNLOAD_DIR, `${jobId}.%(ext)s`);

  const args = ["--no-playlist", "--newline", "-o", outTemplate];

  if (isMp3) {
    args.push("-x", "--audio-format", "mp3");
    if (audioBitrate) {
      args.push("--audio-quality", `${audioBitrate}K`);
    }
  } else {
    if (hasAudio) {
      args.push("-f", formatId);
    } else {
      args.push("-f", `${formatId}+bestaudio`);
    }
    args.push("--merge-output-format", "mp4");
  }

  args.push(url);

  const proc = spawn("yt-dlp", args);
  let responded = false;

  proc.once("spawn", () => {
    jobs.set(jobId, {
      path: path.join(DOWNLOAD_DIR, `${jobId}.${ext}`),
      ext,
      title,
      status: "downloading",
    });
    if (!responded) {
      responded = true;
      res.json({ jobId, ext });
    }
  });

  proc.on("error", (spawnErr) => {
    if (!responded) {
      responded = true;
      console.error("yt-dlp spawn error (download):", spawnErr);
      if (spawnErr && spawnErr.code === "ENOENT") {
        return res.status(500).json({
          error: "yt-dlp not found",
          details: "Install yt-dlp and ensure it is available in PATH.",
        });
      }
      return res.status(500).json({
        error: "Failed to start yt-dlp",
        details: spawnErr?.message || "Unknown spawn error",
      });
    }
    sendProgress(jobId, { type: "error", jobId });
  });

  proc.stdout.on("data", (d) => {
    const lines = d.toString("utf8").split(/\r?\n/);
    for (const line of lines) {
      const parsed = parseProgress(line);
      if (parsed.percent !== null) {
        sendProgress(jobId, {
          type: "progress",
          jobId,
          percent: parsed.percent,
          speed: parsed.speed,
          eta: parsed.eta,
        });
      }
    }
  });

  proc.stderr.on("data", (d) => {
    const line = d.toString("utf8");
    const parsed = parseProgress(line);
    if (parsed.percent !== null) {
      sendProgress(jobId, {
        type: "progress",
        jobId,
        percent: parsed.percent,
        speed: parsed.speed,
        eta: parsed.eta,
      });
    }
  });

  proc.on("close", (code) => {
    if (!responded) {
      responded = true;
      res.json({ jobId, ext });
    }
    const job = jobs.get(jobId);
    if (!job) return;
    if (code === 0 && fs.existsSync(job.path)) {
      job.status = "done";
      sendProgress(jobId, {
        type: "done",
        jobId,
        downloadUrl: `/api/file/${jobId}`,
        filename: `${job.title}.${job.ext}`,
      });
    } else {
      console.error("yt-dlp download failed:", { jobId, code });
      job.status = "error";
      sendProgress(jobId, { type: "error", jobId });
    }
  });
});

app.get("/api/file/:jobId", (req, res) => {
  const jobId = String(req.params.jobId || "");
  const job = jobs.get(jobId);
  if (!job || !fs.existsSync(job.path)) {
    return res.status(404).send("File not found");
  }
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${job.title}.${job.ext}"`
  );
  res.sendFile(job.path);
});

wss.on("connection", (ws) => {
  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString("utf8"));
    } catch {
      return;
    }
    if (msg.type === "subscribe" && msg.jobId) {
      const jobId = String(msg.jobId);
      if (!wsSubscribers.has(jobId)) wsSubscribers.set(jobId, new Set());
      wsSubscribers.get(jobId).add(ws);
    }
  });

  ws.on("close", () => {
    for (const subs of wsSubscribers.values()) subs.delete(ws);
  });
});

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
