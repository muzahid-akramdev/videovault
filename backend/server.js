// VideoVault backend — with Facebook/Instagram cookie session support
// Requires on host: yt-dlp (pip install -U yt-dlp) + ffmpeg
// ONLY download your own content or content you have rights to.

const express = require("express");
const cors = require("cors");
const path = require("path");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json({ limit: "2mb" })); // cookies can be a few KB
app.use(express.static(path.join(__dirname, "..", "frontend")));

// Cookie file path — stored server-side, reused across requests
const COOKIE_FILE = path.join(os.homedir(), ".videovault_cookies.txt");

// ---- rate limiting ----
const hits = new Map();
function rateLimit(req, res, next) {
  const ip = req.ip;
  const now = Date.now();
  const entry = hits.get(ip) || { count: 0, start: now };
  if (now - entry.start > 60_000) { entry.count = 0; entry.start = now; }
  entry.count++;
  hits.set(ip, entry);
  if (entry.count > 15) return res.status(429).json({ error: "Too many requests. Wait a moment." });
  next();
}

function isLikelyUrl(str) {
  try { const u = new URL(str); return u.protocol === "http:" || u.protocol === "https:"; }
  catch { return false; }
}

function runYtDlp(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn("yt-dlp", args);
    let stdout = "", stderr = "";
    proc.stdout.on("data", d => stdout += d);
    proc.stderr.on("data", d => stderr += d);
    proc.on("error", reject);
    proc.on("close", code => {
      if (code !== 0) reject(new Error(stderr.trim() || `yt-dlp exited ${code}`));
      else resolve(stdout);
    });
  });
}

// Build yt-dlp args that include cookies if the file exists
function cookieArgs() {
  if (fs.existsSync(COOKIE_FILE)) return ["--cookies", COOKIE_FILE];
  return [];
}

// ---- ROUTES ----

// Save cookies from browser (Netscape/Mozilla cookie format as plain text)
app.post("/api/cookies", (req, res) => {
  const { cookies } = req.body || {};
  if (!cookies || typeof cookies !== "string" || cookies.trim().length < 10) {
    return res.status(400).json({ error: "No cookie text provided." });
  }
  // Must start with the Netscape header or contain tab-separated cookie lines
  const trimmed = cookies.trim();
  const header = "# Netscape HTTP Cookie File";
  const content = trimmed.startsWith("#") ? trimmed : header + "\n" + trimmed;
  fs.writeFileSync(COOKIE_FILE, content + "\n", "utf8");
  res.json({ ok: true, message: "Cookies saved. Facebook & Instagram should now work." });
});

// Check if cookies are loaded
app.get("/api/cookies/status", (req, res) => {
  const exists = fs.existsSync(COOKIE_FILE);
  if (!exists) return res.json({ loaded: false });
  const stat = fs.statSync(COOKIE_FILE);
  const lines = fs.readFileSync(COOKIE_FILE, "utf8").split("\n")
    .filter(l => l.trim() && !l.startsWith("#")).length;
  res.json({ loaded: true, lines, savedAt: stat.mtimeMs });
});

// Delete saved cookies
app.delete("/api/cookies", (req, res) => {
  if (fs.existsSync(COOKIE_FILE)) fs.unlinkSync(COOKIE_FILE);
  res.json({ ok: true });
});

// Analyze URL
app.post("/api/analyze", rateLimit, async (req, res) => {
  const { url } = req.body || {};
  if (!url || !isLikelyUrl(url)) return res.status(400).json({ error: "Provide a valid https URL." });

  try {
    const raw = await runYtDlp(["-j", "--no-warnings", "--no-playlist", ...cookieArgs(), url]);
    const info = JSON.parse(raw);

    const seen = new Set();
    const formats = (info.formats || [])
      .filter(f => f.vcodec !== "none" || f.acodec !== "none")
      .map(f => {
        const audioOnly = f.vcodec === "none";
        const label = audioOnly
          ? `Audio only · ${f.acodec || "audio"}${f.abr ? " · " + Math.round(f.abr) + "kbps" : ""}`
          : `${f.height ? f.height + "p" : f.format_note || "video"} · ${f.ext}`;
        return { format_id: f.format_id, label: label.trim(), ext: f.ext, height: f.height || 0, filesize: f.filesize || f.filesize_approx || null, audioOnly };
      })
      .filter(f => { const k = f.label + f.ext; if (seen.has(k)) return false; seen.add(k); return true; })
      .sort((a, b) => b.height - a.height)
      .slice(0, 12);

    res.json({ title: info.title, thumbnail: info.thumbnail, duration: info.duration, uploader: info.uploader, extractor: info.extractor_key, webpage_url: info.webpage_url, formats });
  } catch (err) {
    const msg = err.message || "";
    if (/ENOENT|not found|not recognized/i.test(msg)) {
      return res.status(500).json({ error: "yt-dlp is not installed. Run: pip install -U yt-dlp" });
    }
    if (/login|log in|sign in|cookie|authenticate/i.test(msg)) {
      return res.status(401).json({ error: "This video requires you to be logged in. Add your Facebook/Instagram session cookies above.", needsCookies: true });
    }
    res.status(422).json({ error: "Could not read that link. It may be private or the platform is blocking access.", detail: msg.slice(0, 300) });
  }
});

// Download
app.get("/api/download", rateLimit, async (req, res) => {
  const { url, format_id } = req.query;
  if (!url || !isLikelyUrl(url) || !format_id) return res.status(400).json({ error: "Missing url or format_id." });

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vv-"));
  const outTemplate = path.join(tmpDir, "%(title).80s.%(ext)s");
  const args = ["-f", `${format_id}+bestaudio/best`, "--no-playlist", "--no-warnings", "--merge-output-format", "mp4", ...cookieArgs(), "-o", outTemplate, url];

  const proc = spawn("yt-dlp", args);
  let stderr = "";
  proc.stderr.on("data", d => stderr += d);
  proc.on("error", () => { cleanup(); if (!res.headersSent) res.status(500).json({ error: "yt-dlp not installed." }); });
  proc.on("close", code => {
    if (code !== 0) { cleanup(); if (!res.headersSent) return res.status(422).json({ error: "Download failed.", detail: stderr.slice(0, 300) }); return; }
    const files = fs.readdirSync(tmpDir);
    if (!files.length) { cleanup(); return res.status(500).json({ error: "No output file produced." }); }
    res.download(path.join(tmpDir, files[0]), files[0], () => cleanup());
  });

  function cleanup() { fs.rm(tmpDir, { recursive: true, force: true }, () => {}); }
});

app.get("/api/health", (req, res) => res.json({ ok: true }));

app.listen(PORT, () => console.log(`VideoVault running on http://localhost:${PORT}`));
