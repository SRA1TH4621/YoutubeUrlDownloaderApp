const path = require("path");
const fs = require("fs");
const { spawn, exec } = require("child_process");
const express = require("express");
const http = require("http");
const WebSocket = require("ws");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;
const DOWNLOAD_DIR = path.join(__dirname, "..", "downloads");

const jobs = new Map();
const wsSubscribers = new Map();

if (!fs.existsSync(DOWNLOAD_DIR)) {
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
}

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "..", "client")));

function safeFilename(name) {
  return (name || "video")
    .replace(/[^\x20-\x7E]+/g, "")
    .replace(/[<>:"/\\|?*]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

function sendProgress(jobId, payload) {
  const subs = wsSubscribers.get(jobId);
  if (!subs) return;

  const msg = JSON.stringify(payload);

  for (const ws of subs) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(msg);
    }
  }
}

function parseProgress(line) {
  const percent = line.match(/(\d+(?:\.\d+)?)%/);
  const speed = line.match(/at\s+([0-9.]+\s*[KMG]i?B\/s)/i);
  const eta = line.match(/ETA\s+([0-9:]+)/i);

  return {
    percent: percent ? Number(percent[1]) : null,
    speed: speed ? speed[1] : null,
    eta: eta ? eta[1] : null,
  };
}

function mapFormats(info) {
  const wanted = [360, 480, 720, 1080, 1440, 2160, 4320];
  const formats = info.formats || [];

  const results = [];

  for (const height of wanted) {
    const candidates = formats.filter(
      (f) => f.height === height && f.vcodec !== "none",
    );

    if (!candidates.length) continue;

    const best = candidates.sort((a, b) => (b.tbr || 0) - (a.tbr || 0))[0];

    const sizeBytes = best.filesize || best.filesize_approx || 0;

    const sizeMb = sizeBytes
      ? `${(sizeBytes / 1024 / 1024).toFixed(2)} MB`
      : "";

    results.push({
      height,
      label: height >= 2160 ? `${height / 1080}K` : `${height}p`,
      formatId: best.format_id,
      ext: best.ext || "mp4",
      hasAudio: best.acodec !== "none",
      sizeMb,
    });
  }

  return results;
}

exec("python3 -m yt_dlp --version", (err, stdout) => {
  console.log("yt-dlp version:", stdout);
});

app.post("/api/info", (req, res) => {
  const url = String(req.body?.url || "").trim();

  if (!url) return res.status(400).json({ error: "Missing URL" });

  const proc = spawn("python3", ["-m", "yt_dlp", "-J", "--no-playlist", url]);

  let data = "";
  let err = "";

  proc.stdout.on("data", (d) => (data += d.toString()));
  proc.stderr.on("data", (d) => (err += d.toString()));

  proc.on("close", (code) => {
    if (code !== 0) {
      console.error("yt-dlp error:", err);
      return res.status(500).json({ error: "Failed to fetch info" });
    }

    try {
      const info = JSON.parse(data);

      res.json({
        id: info.id,
        title: info.title,
        thumbnail: info.thumbnail,
        duration: info.duration,
        embedUrl: `https://www.youtube.com/embed/${info.id}`,
        formats: mapFormats(info),
      });
    } catch (e) {
      res.status(500).json({ error: "Invalid yt-dlp response" });
    }
  });
});

app.post("/api/download", (req, res) => {
  const url = String(req.body.url || "");
  const formatId = String(req.body.formatId || "");
  const hasAudio = Boolean(req.body.hasAudio);
  const isMp3 = Boolean(req.body.isMp3);

  const title = safeFilename(req.body.title || "video");

  const jobId = "job_" + Date.now();

  const ext = isMp3 ? "mp3" : "mp4";

  const output = path.join(DOWNLOAD_DIR, `${jobId}.%(ext)s`);

  const args = ["--newline", "-o", output];

  if (isMp3) {
    args.push("-x", "--audio-format", "mp3");
  } else {
    if (hasAudio) {
      args.push("-f", formatId);
    } else {
      args.push("-f", `${formatId}+bestaudio`);
      args.push("--merge-output-format", "mp4");
    }
  }

  args.push(url);

  const proc = spawn("python3", ["-m", "yt_dlp", ...args]);

  jobs.set(jobId, {
    path: path.join(DOWNLOAD_DIR, `${jobId}.${ext}`),
    title,
    ext,
    status: "downloading",
  });

  res.json({ jobId, ext });

  proc.stdout.on("data", (d) => {
    const lines = d.toString().split("\n");

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

  proc.on("close", (code) => {
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
      job.status = "error";

      sendProgress(jobId, { type: "error", jobId });
    }
  });
});

app.get("/api/file/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);

  if (!job || !fs.existsSync(job.path)) {
    return res.status(404).send("File not found");
  }

  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${job.title}.${job.ext}"`,
  );

  res.sendFile(job.path);
});

wss.on("connection", (ws) => {
  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw);

      if (msg.type === "subscribe" && msg.jobId) {
        if (!wsSubscribers.has(msg.jobId)) {
          wsSubscribers.set(msg.jobId, new Set());
        }

        wsSubscribers.get(msg.jobId).add(ws);
      }
    } catch {}
  });

  ws.on("close", () => {
    for (const subs of wsSubscribers.values()) {
      subs.delete(ws);
    }
  });
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
