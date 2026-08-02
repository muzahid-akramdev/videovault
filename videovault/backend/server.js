// VideoVault backend — with Facebook/Instagram cookie session support
// + passcode gate for shared (friends/family) deployments.
// Requires on host: yt-dlp (pip install -U yt-dlp) + ffmpeg
// ONLY download your own content or content you have rights to.

const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");

const app = express();
const PORT = process.env.PORT || 3001;
const SITE_PASSCODE = process.env.SITE_PASSCODE;
const IS_PROD = process.env.NODE_ENV === "production";

if (!SITE_PASSCODE) {
  console.warn("\n⚠️  WARNING: SITE_PASSCODE is not set. Set it in your .env file (local) or\n" +
               "   your host's environment variables (Render/Railway) before deploying,\n" +
               "   or anyone can access this site.\n");
}

app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use(cookieParser());

const FRONTEND_DIR = path.join(__dirname, "..", "frontend");
const COOKIE_FILE = path.join(os.homedir(), ".videovault_cookies.txt");

// ---- session tokens (in-memory; resets on server restart, which is fine
//      for a small shared group — they just log in again) ----
const validTokens = new Set();

function isAuthed(req) {
  const token = req.cookies && req.cookies.vv_session;
  return !!token && validTokens.has(token);
}

function requireAuth(req, res, next) {
  if (!SITE_PASSCODE) return next(); // no passcode configured -> open (dev mode)
  if (isAuthed(req)) return next();
  res.status(401).json({ error: "Not logged in.", needsLogin: true });
}

// ---- login rate limiting (separate, stricter than general API limit) ----
const loginAttempts = new Map();
function loginRateLimit(req, res, next) {
  const ip = req.ip;
  const now = Date.now();
  const entry = loginAttempts.get(ip) || { count: 0, start: now };
  if (now - entry.start > 5 * 60_000) { entry.count = 0; entry.start = now; }
  entry.count++;
  loginAttempts.set(ip, entry);
  if (entry.count > 8) return res.status(429).json({ error: "Too many attempts. Wait a few minutes." });
  next();
}

// ---- general API rate limiting ----
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

function cookieArgs() {
  if (fs.existsSync(COOKIE_FILE)) return ["--cookies", COOKIE_FILE];
  return [];
}

// ============ AUTH ROUTES ============

app.post("/api/login", loginRateLimit, (req, res) => {
  const { passcode } = req.body || {};
  if (!SITE_PASSCODE) return res.json({ ok: true }); // dev mode, no gate configured

  if (!passcode || passcode !== SITE_PASSCODE) {
    return res.status(401).json({ error: "Wrong passcode." });
  }

  const token = crypto.randomBytes(32).toString("hex");
  validTokens.add(token);

  res.cookie("vv_session", token, {
    httpOnly: true,
    secure: IS_PROD,
    sameSite: "lax",
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
  });
  res.json({ ok: true });
});

app.post("/api/logout", (req, res) => {
  const token = req.cookies && req.cookies.vv_session;
  if (token) validTokens.delete(token);
  res.clearCookie("vv_session");
  res.json({ ok: true });
});

app.get("/api/session", (req, res) => {
  res.json({ authed: isAuthed(req) || !SITE_PASSCODE, gateEnabled: !!SITE_PASSCODE });
});

// ============ PAGE ROUTES ============

app.get("/login", (req, res) => {
  if (!SITE_PASSCODE || isAuthed(req)) return res.redirect("/");
  res.sendFile(path.join(FRONTEND_DIR, "login.html"));
});

app.get("/", (req, res) => {
  if (SITE_PASSCODE && !isAuthed(req)) return res.redirect("/login");
  res.sendFile(path.join(FRONTEND_DIR, "index.html"));
});

// ============ COOKIE (Facebook/Instagram session) ROUTES ============

app.post("/api/cookies", requireAuth, (req, res) => {
  const { cookies } = req.body || {};
  if (!cookies || typeof cookies !== "string" || cookies.trim().length < 10) {
    return res.status(400).json({ error: "No cookie text provided." });
  }
  const trimmed = cookies.trim();
  const header = "# Netscape HTTP Cookie File";
  const content = trimmed.startsWith("#") ? trimmed : header + "\n" + trimmed;
  fs.writeFileSync(COOKIE_FILE, content + "\n", "utf8");
  res.json({ ok: true, message: "Cookies saved. Facebook & Instagram should now work." });
});

app.get("/api/cookies/status", requireAuth, (req, res) => {
  const exists = fs.existsSync(COOKIE_FILE);
  if (!exists) return res.json({ loaded: false });
  const stat = fs.statSync(COOKIE_FILE);
  const lines = fs.readFileSync(COOKIE_FILE, "utf8").split("\n")
    .filter(l => l.trim() && !l.startsWith("#")).length;
  res.json({ loaded: true, lines, savedAt: stat.mtimeMs });
});

app.delete("/api/cookies", requireAuth, (req, res) => {
  if (fs.existsSync(COOKIE_FILE)) fs.unlinkSync(COOKIE_FILE);
  res.json({ ok: true });
});

// ============ VIDEO ROUTES ============

app.post("/api/analyze", requireAuth, rateLimit, async (req, res) => {
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

app.get("/api/download", requireAuth, rateLimit, async (req, res) => {
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
