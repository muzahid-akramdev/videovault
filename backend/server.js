// VideoVault backend — cookie session + yt-dlp wrapper
// Requires on host: yt-dlp + ffmpeg (see Dockerfile)
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
// Passcode screen is OFF unless you set both SITE_GATE=1 and SITE_PASSCODE.
// A leftover SITE_PASSCODE in Render/Railway must not lock the owner out.
const SITE_PASSCODE =
  process.env.SITE_GATE === "1" ? process.env.SITE_PASSCODE : "";
const IS_PROD = process.env.NODE_ENV === "production";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

if (SITE_PASSCODE) {
  console.log("Passcode gate is on.");
} else {
  console.log("Passcode gate is off — app is open.");
}

app.use(cors());
app.use(express.json({ limit: "8mb" }));
app.use(cookieParser());

const FRONTEND_DIR = path.join(__dirname, "..", "frontend");
const COOKIE_FILE = path.join(os.homedir(), ".videovault_cookies.txt");
const COOKIE_META_FILE = path.join(os.homedir(), ".videovault_cookies.meta.json");

const validTokens = new Set();

function isAuthed(req) {
  const token = req.cookies && req.cookies.vv_session;
  return !!token && validTokens.has(token);
}

function requireAuth(req, res, next) {
  if (!SITE_PASSCODE) return next();
  if (isAuthed(req)) return next();
  res.status(401).json({ error: "Not logged in.", needsLogin: true });
}

const loginAttempts = new Map();
function loginRateLimit(req, res, next) {
  const ip = req.ip;
  const now = Date.now();
  const entry = loginAttempts.get(ip) || { count: 0, start: now };
  if (now - entry.start > 5 * 60_000) {
    entry.count = 0;
    entry.start = now;
  }
  entry.count++;
  loginAttempts.set(ip, entry);
  if (entry.count > 8) {
    return res.status(429).json({ error: "Too many attempts. Wait a few minutes." });
  }
  next();
}

const hits = new Map();
function rateLimit(req, res, next) {
  const ip = req.ip;
  const now = Date.now();
  const entry = hits.get(ip) || { count: 0, start: now };
  if (now - entry.start > 60_000) {
    entry.count = 0;
    entry.start = now;
  }
  entry.count++;
  hits.set(ip, entry);
  if (entry.count > 20) {
    return res.status(429).json({ error: "Too many requests. Wait a moment." });
  }
  next();
}

function isLikelyUrl(str) {
  try {
    const u = new URL(str);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function canonicalizeUrl(raw) {
  let s = String(raw || "").trim();
  if (!s) return s;
  s = s.replace(/m\.facebook\.com/i, "www.facebook.com");
  s = s.replace(/m\.instagram\.com/i, "www.instagram.com");
  s = s.replace(/^http:\/\//i, "https://");
  return s;
}

function refererFor(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "").replace(/^m\./, "");
    if (host.includes("facebook") || host === "fb.com" || host === "fb.watch") {
      return "https://www.facebook.com/";
    }
    if (host.includes("instagram")) return "https://www.instagram.com/";
    if (host.includes("youtube") || host === "youtu.be") return "https://www.youtube.com/";
    return u.origin + "/";
  } catch {
    return "https://www.facebook.com/";
  }
}

function runYtDlp(args, { timeoutMs = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn("yt-dlp", args, { env: { ...process.env, PYTHONUNBUFFERED: "1" } });
    let stdout = "";
    let stderr = "";
    const timer = timeoutMs
      ? setTimeout(() => {
          proc.kill("SIGKILL");
          reject(new Error(`yt-dlp timed out after ${Math.round(timeoutMs / 1000)}s`));
        }, timeoutMs)
      : null;
    proc.stdout.on("data", (d) => (stdout += d));
    proc.stderr.on("data", (d) => (stderr += d));
    proc.on("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    proc.on("close", (code) => {
      if (timer) clearTimeout(timer);
      if (code !== 0) reject(new Error((stderr || stdout).trim() || `yt-dlp exited ${code}`));
      else resolve(stdout);
    });
  });
}

function parseYtDlpJson(stdout) {
  const text = String(stdout || "").trim();
  const start = text.indexOf("{");
  if (start === -1) throw new Error("yt-dlp returned no JSON");
  const sliced = text.slice(start);
  try {
    return JSON.parse(sliced);
  } catch {
    /* fall through */
  }
  const lines = sliced.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.startsWith("{")) continue;
    try {
      return JSON.parse(line);
    } catch {
      /* keep looking */
    }
  }
  throw new Error("Could not parse yt-dlp output");
}

// ---------- cookie import (Netscape / JSON / header string) ----------

function splitNetscapeLine(line) {
  let httpOnly = false;
  let rest = line;
  if (rest.startsWith("#HttpOnly_")) {
    httpOnly = true;
    rest = rest.slice("#HttpOnly_".length);
  }
  if (rest.includes("\t")) {
    const parts = rest.split("\t");
    if (parts.length >= 7) {
      return {
        httpOnly,
        domain: parts[0].trim(),
        flag: parts[1].trim().toUpperCase() === "TRUE" ? "TRUE" : "FALSE",
        path: parts[2].trim() || "/",
        secure: parts[3].trim().toUpperCase() === "TRUE" ? "TRUE" : "FALSE",
        exp: String(parseInt(parts[4], 10) || 0),
        name: parts[5].trim(),
        value: parts.slice(6).join("\t"),
      };
    }
  }
  const m = rest.match(
    /^(\S+)\s+(TRUE|FALSE)\s+(\S+)\s+(TRUE|FALSE)\s+(-?\d+(?:\.\d+)?)\s+(\S+)\s+(.*)$/i
  );
  if (!m) return null;
  return {
    httpOnly,
    domain: m[1],
    flag: m[2].toUpperCase(),
    path: m[3] || "/",
    secure: m[4].toUpperCase(),
    exp: String(parseInt(m[5], 10) || 0),
    name: m[6],
    value: m[7],
  };
}

function jsonCookieToRow(c) {
  if (!c || typeof c !== "object") return null;
  const name = String(c.name || c.key || "").trim();
  if (!name) return null;
  const value = c.value == null ? "" : String(c.value);
  let domain = String(c.domain || c.host || ".facebook.com");
  if (!domain.startsWith(".") && c.hostOnly === false) domain = "." + domain.replace(/^\./, "");
  const path = c.path || "/";
  const secure = c.secure ? "TRUE" : "FALSE";
  let exp = 0;
  if (typeof c.expirationDate === "number") exp = Math.round(c.expirationDate);
  else if (typeof c.expires === "number") {
    exp = c.expires > 1e12 ? Math.round(c.expires / 1000) : Math.round(c.expires);
  } else if (typeof c.expires === "string") {
    const t = Date.parse(c.expires);
    if (!Number.isNaN(t)) exp = Math.round(t / 1000);
  }
  const httpOnly = !!(c.httpOnly || c.http_only);
  const flag = domain.startsWith(".") ? "TRUE" : "FALSE";
  return { httpOnly, domain, flag, path, secure, exp: String(exp), name, value };
}

function headerStringToRows(raw, defaultDomain) {
  const rows = [];
  const parts = raw.split(";");
  for (const part of parts) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const name = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!name) continue;
    rows.push({
      httpOnly: false,
      domain: defaultDomain,
      flag: "TRUE",
      path: "/",
      secure: "TRUE",
      exp: "0",
      name,
      value,
    });
  }
  return rows;
}

function rowToNetscape(row) {
  const prefix = row.httpOnly ? "#HttpOnly_" : "";
  return `${prefix}${row.domain}\t${row.flag}\t${row.path}\t${row.secure}\t${row.exp}\t${row.name}\t${row.value}`;
}

function domainOf(row) {
  return String(row.domain || "")
    .replace(/^\./, "")
    .toLowerCase();
}

function hasNamedCookie(rows, name, domainPart) {
  const n = name.toLowerCase();
  const d = domainPart.toLowerCase();
  return rows.some((r) => r.name.toLowerCase() === n && domainOf(r).includes(d));
}

function inspectRows(rows) {
  const facebook = hasNamedCookie(rows, "c_user", "facebook") || hasNamedCookie(rows, "c_user", "fb.com");
  const facebookXs = hasNamedCookie(rows, "xs", "facebook") || hasNamedCookie(rows, "xs", "fb.com");
  const instagram = hasNamedCookie(rows, "sessionid", "instagram");
  const youtube =
    hasNamedCookie(rows, "SID", "youtube") ||
    hasNamedCookie(rows, "SID", "google") ||
    hasNamedCookie(rows, "__Secure-1PSID", "youtube") ||
    hasNamedCookie(rows, "LOGIN_INFO", "youtube");
  return {
    lines: rows.length,
    facebook: facebook && facebookXs,
    facebookPartial: facebook && !facebookXs,
    instagram,
    youtube,
  };
}

function parseCookieInput(raw) {
  if (!raw || typeof raw !== "string") {
    throw new Error("No cookie text provided.");
  }
  let trimmed = raw.trim().replace(/^\uFEFF/, "");
  if (trimmed.length < 8) throw new Error("Cookie text is too short.");

  let rows = [];
  let dropped = 0;
  let source = "netscape";

  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    source = "json";
    let data;
    try {
      data = JSON.parse(trimmed);
    } catch {
      throw new Error("Looks like JSON but it is not valid JSON. Export Netscape or valid Cookie-Editor JSON.");
    }
    if (data && !Array.isArray(data) && Array.isArray(data.cookies)) data = data.cookies;
    if (data && !Array.isArray(data) && typeof data === "object") {
      data = Object.entries(data).map(([name, value]) =>
        value && typeof value === "object" ? { name, ...value } : { name, value }
      );
    }
    if (!Array.isArray(data)) throw new Error("JSON cookies must be an array.");
    for (const item of data) {
      const row = jsonCookieToRow(item);
      if (row && row.name) rows.push(row);
      else dropped++;
    }
  } else if (
    !trimmed.includes("\t") &&
    !trimmed.includes("\n") &&
    /;\s*[\w-]+=/.test(trimmed)
  ) {
    source = "header";
    rows = headerStringToRows(trimmed, ".facebook.com");
  } else {
    const lines = trimmed.split(/\r?\n/);
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      if (t.startsWith("#") && !t.startsWith("#HttpOnly_")) continue;
      const row = splitNetscapeLine(t);
      if (row && row.name) rows.push(row);
      else dropped++;
    }
  }

  // de-dupe by domain+name, keep last
  const seen = new Map();
  for (const row of rows) {
    seen.set(`${domainOf(row)}|${row.name}`, row);
  }
  rows = [...seen.values()];

  if (!rows.length) {
    throw new Error(
      "Could not read any cookies. Export from Cookie-Editor as Netscape or JSON while you are logged in."
    );
  }

  const header = "# Netscape HTTP Cookie File\n# Converted by VideoVault\n";
  const body = rows.map(rowToNetscape).join("\n");
  const inspect = inspectRows(rows);
  return { content: header + body + "\n", dropped, source, ...inspect, rows };
}

function cookieArgs() {
  if (fs.existsSync(COOKIE_FILE)) return ["--cookies", COOKIE_FILE];
  return [];
}

function commonYtArgs(url) {
  const args = [
    "--no-playlist",
    "--no-warnings",
    "--newline",
    "--user-agent",
    UA,
    "--add-header",
    `Referer:${refererFor(url)}`,
    "--add-header",
    `Origin:${refererFor(url).replace(/\/$/, "")}`,
    "--socket-timeout",
    "30",
    "--retries",
    "5",
    "--fragment-retries",
    "5",
    "--geo-bypass",
    "--js-runtimes",
    "node",
    "--extractor-args",
    "youtube:player_client=web_safari,tv",
    ...cookieArgs(),
  ];
  return args;
}

function loadCookieMeta() {
  try {
    if (fs.existsSync(COOKIE_META_FILE)) {
      return JSON.parse(fs.readFileSync(COOKIE_META_FILE, "utf8"));
    }
  } catch {
    /* ignore */
  }
  if (!fs.existsSync(COOKIE_FILE)) return null;
  try {
    const parsed = parseCookieInput(fs.readFileSync(COOKIE_FILE, "utf8"));
    return {
      lines: parsed.lines,
      facebook: parsed.facebook,
      facebookPartial: parsed.facebookPartial,
      instagram: parsed.instagram,
      youtube: parsed.youtube,
      dropped: parsed.dropped,
      source: parsed.source,
      savedAt: fs.statSync(COOKIE_FILE).mtimeMs,
    };
  } catch {
    return { lines: 0, facebook: false, instagram: false, youtube: false };
  }
}

function formatSelector(formatId, audioOnly) {
  if (audioOnly) return `${formatId}/bestaudio/best`;
  // Prefer the exact format. Only merge audio if that format has no audio.
  // The old `${id}+bestaudio/best` fails on Facebook progressive (already muxed) streams.
  return `${formatId}/bestvideo*+bestaudio/best`;
}

function friendlyYtError(msg) {
  const m = String(msg || "");
  if (/ENOENT|not found|not recognized/i.test(m)) {
    return {
      status: 500,
      error: "yt-dlp is not installed. Run: pip install -U yt-dlp",
      detail: m.slice(0, 400),
    };
  }
  if (/does not look like a Netscape|unable to load cookies|cookie file/i.test(m)) {
    return {
      status: 400,
      error:
        "Cookie file is not valid Netscape format. Clear session and re-export as Netscape or JSON from Cookie-Editor.",
      detail: m.slice(0, 400),
      needsCookies: true,
    };
  }
  if (/login required|please log in|sign in to|cookies? (are )?needed|authentication/i.test(m)) {
    return {
      status: 401,
      error:
        "This video needs a logged-in session. 866 random cookies are not enough — export while logged into facebook.com / instagram.com (look for c_user or sessionid).",
      detail: m.slice(0, 400),
      needsCookies: true,
    };
  }
  if (/confirm you.?re not a bot/i.test(m)) {
    return {
      status: 401,
      error:
        "The site is treating this server like a bot. Fresh YouTube cookies from a browser (Netscape/JSON) usually clear it; Facebook official export is more reliable for your own videos.",
      detail: m.slice(0, 400),
      needsCookies: true,
    };
  }
  if (/private video|this video is unavailable|cannot parse data/i.test(m)) {
    return {
      status: 422,
      error:
        "Could not read that video. If it is yours: use a canonical facebook.com/reel/… or /videos/… URL (not share/v), and a cookie export that includes c_user + xs. Facebook also changes their page often — this can be an extractor lag, not your cookies.",
      detail: m.slice(0, 400),
    };
  }
  if (/Requested format is not available/i.test(m)) {
    return {
      status: 422,
      error: "That quality is gone. Analyze the link again and pick another format.",
      detail: m.slice(0, 400),
    };
  }
  return {
    status: 422,
    error: "Could not read that link. It may be private, geo-blocked, or the platform is blocking access.",
    detail: m.slice(0, 500),
  };
}

// ============ AUTH ROUTES ============

app.post("/api/login", loginRateLimit, (req, res) => {
  const { passcode } = req.body || {};
  if (!SITE_PASSCODE) return res.json({ ok: true });
  if (!passcode || passcode !== SITE_PASSCODE) {
    return res.status(401).json({ error: "Wrong passcode." });
  }
  const token = crypto.randomBytes(32).toString("hex");
  validTokens.add(token);
  res.cookie("vv_session", token, {
    httpOnly: true,
    secure: IS_PROD,
    sameSite: "lax",
    maxAge: 30 * 24 * 60 * 60 * 1000,
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

app.use(express.static(FRONTEND_DIR));

// ============ COOKIE ROUTES ============

app.post("/api/cookies", requireAuth, (req, res) => {
  const { cookies } = req.body || {};
  try {
    const parsed = parseCookieInput(cookies);
    fs.writeFileSync(COOKIE_FILE, parsed.content, "utf8");
    const meta = {
      lines: parsed.lines,
      facebook: parsed.facebook,
      facebookPartial: parsed.facebookPartial,
      instagram: parsed.instagram,
      youtube: parsed.youtube,
      dropped: parsed.dropped,
      source: parsed.source,
      savedAt: Date.now(),
    };
    fs.writeFileSync(COOKIE_META_FILE, JSON.stringify(meta), "utf8");

    const logged = [];
    if (meta.facebook) logged.push("Facebook");
    if (meta.instagram) logged.push("Instagram");
    if (meta.youtube) logged.push("YouTube");

    let message;
    if (logged.length) {
      message = `Cookies saved (${parsed.lines} valid). Logged in: ${logged.join(", ")}.`;
    } else if (meta.facebookPartial) {
      message =
        `Saved ${parsed.lines} cookies, found Facebook c_user but not xs. Re-export from facebook.com while fully logged in (Cookie-Editor → Netscape or JSON).`;
    } else {
      message =
        `Saved ${parsed.lines} cookies, but no Facebook/Instagram login cookie was found (need c_user + xs, or sessionid). A full-browser dump of hundreds of cookies will show as “active” and still fail. Open facebook.com, log in, then export.`;
    }
    res.json({ ok: true, message, ...meta, loaded: true });
  } catch (err) {
    res.status(400).json({ error: err.message || "Could not parse cookies." });
  }
});

app.get("/api/cookies/status", requireAuth, (req, res) => {
  const meta = loadCookieMeta();
  if (!meta) return res.json({ loaded: false });
  res.json({ loaded: true, ...meta });
});

app.delete("/api/cookies", requireAuth, (req, res) => {
  if (fs.existsSync(COOKIE_FILE)) fs.unlinkSync(COOKIE_FILE);
  if (fs.existsSync(COOKIE_META_FILE)) fs.unlinkSync(COOKIE_META_FILE);
  res.json({ ok: true });
});

// ============ VIDEO ROUTES ============

app.post("/api/analyze", requireAuth, rateLimit, async (req, res) => {
  const url = canonicalizeUrl((req.body || {}).url);
  if (!url || !isLikelyUrl(url)) {
    return res.status(400).json({ error: "Provide a valid https URL." });
  }

  try {
    const raw = await runYtDlp(["-J", ...commonYtArgs(url), url], { timeoutMs: 90_000 });
    const info = parseYtDlpJson(raw);

    const seen = new Set();
    const formats = (info.formats || [])
      .filter((f) => f.vcodec !== "none" || f.acodec !== "none")
      .map((f) => {
        const audioOnly = f.vcodec === "none";
        const label = audioOnly
          ? `Audio only · ${f.acodec || "audio"}${f.abr ? " · " + Math.round(f.abr) + "kbps" : ""}`
          : `${f.height ? f.height + "p" : f.format_note || "video"} · ${f.ext}`;
        return {
          format_id: f.format_id,
          label: label.trim(),
          ext: f.ext,
          height: f.height || 0,
          filesize: f.filesize || f.filesize_approx || null,
          audioOnly,
        };
      })
      .filter((f) => {
        const k = f.label + f.ext + f.format_id;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .sort((a, b) => b.height - a.height)
      .slice(0, 16);

    res.json({
      title: info.title,
      thumbnail: info.thumbnail,
      duration: info.duration,
      uploader: info.uploader,
      extractor: info.extractor_key,
      webpage_url: info.webpage_url,
      formats,
    });
  } catch (err) {
    const mapped = friendlyYtError(err.message || "");
    res.status(mapped.status).json(mapped);
  }
});

app.get("/api/download", requireAuth, rateLimit, async (req, res) => {
  req.setTimeout(0);
  res.setTimeout(0);

  const url = canonicalizeUrl(req.query.url);
  const format_id = req.query.format_id;
  const audioOnly = String(req.query.audioOnly || "") === "1";
  if (!url || !isLikelyUrl(url) || !format_id) {
    return res.status(400).json({ error: "Missing url or format_id." });
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vv-"));
  const outTemplate = path.join(tmpDir, "%(title).80s.%(ext)s");
  const args = [
    "-f",
    formatSelector(format_id, audioOnly),
    "--merge-output-format",
    "mp4",
    "--no-part",
    "-o",
    outTemplate,
    ...commonYtArgs(url),
    url,
  ];

  const proc = spawn("yt-dlp", args, { env: { ...process.env, PYTHONUNBUFFERED: "1" } });
  let stderr = "";
  proc.stderr.on("data", (d) => (stderr += d));
  proc.stdout.on("data", (d) => (stderr += d));

  const fail = (status, payload) => {
    cleanup();
    if (res.headersSent) return;
    res.status(status).type("html").send(
      `<!doctype html><meta charset="utf-8"><title>Download failed</title>
       <pre style="font:14px/1.5 ui-monospace,monospace;white-space:pre-wrap;padding:24px">${escapeHtml(
         payload.error + (payload.detail ? "\n\n" + payload.detail : "")
       )}</pre>`
    );
  };

  proc.on("error", () => fail(500, { error: "yt-dlp not installed." }));
  proc.on("close", (code) => {
    if (code !== 0) {
      return fail(422, friendlyYtError(stderr.trim() || `yt-dlp exited ${code}`));
    }
    const files = fs.readdirSync(tmpDir).filter((f) => !f.endsWith(".part"));
    if (!files.length) return fail(500, { error: "No output file produced." });
    const filePath = path.join(tmpDir, files[0]);
    res.download(filePath, files[0], () => cleanup());
  });

  function cleanup() {
    fs.rm(tmpDir, { recursive: true, force: true }, () => {});
  }
});

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

app.get("/api/health", (req, res) => res.json({ ok: true }));

app.listen(PORT, "0.0.0.0", () => {
  console.log(`VideoVault running on http://0.0.0.0:${PORT}`);
});
