# VideoVault

Paste a link, see available formats, download the file. Built on
[yt-dlp](https://github.com/yt-dlp/yt-dlp) + ffmpeg, with a passcode gate so
only your friends/family can use it.

## Read this first

- **Only download content you own or have the right to download.** This is
  meant for recovering your own uploads, not other people's content.
- **Facebook & Instagram need you to be logged in.** Use the "Facebook /
  Instagram Login" panel in the app to paste your browser cookies (exported
  via a tool like Cookie-Editor). This is one shared session for your whole
  group — whoever's cookies are saved is the account used for FB/IG requests.
- For recovering your **own** old Facebook videos specifically, Facebook's
  official export (Settings → Your Information → Download Your Information)
  is more reliable than any scraper — use this app as a complement to that.

## Cookies look “active” but download still fails

The badge used to count every non-comment line in the paste, so a whole-browser
dump of ~800 tracking cookies looked like a working session. **yt-dlp does not
care how many cookies you have.** It needs the login cookies:

| Site | Required cookies |
| --- | --- |
| Facebook | `c_user` **and** `xs` (from facebook.com, while logged in) |
| Instagram | `sessionid` |
| YouTube | `SID` / `__Secure-1PSID` — and even then YouTube may still bot-check |

Export **on the facebook.com / instagram.com tab**, Netscape **or** JSON.
Do not use “export all cookies in this browser”.

After saving, the badge must say **Logged in · Facebook** (or Instagram),
not just a number. If it says “no login found”, the paste had no session.

Other failure modes this build also fixes:

- Cookie-Editor **JSON** used to be written as-is; yt-dlp only reads Netscape
  (tab-separated). JSON is now converted.
- Spaces instead of tabs (common after paste) used to make yt-dlp ignore the
  file. Lines are rewritten as real Netscape.
- `-f FORMAT+bestaudio` broke Facebook progressive videos that already have
  audio. Format fallback is now `FORMAT / bestvideo+bestaudio / best`.
- Analyze hid the real yt-dlp error. The red box now shows the extractor
  message.
- Docker image refreshes yt-dlp on boot (Facebook extractors go stale fast).

Use a canonical URL when you can: `facebook.com/reel/…` or
`facebook.com/watch/?v=…`, not `facebook.com/share/v/…` / `share/r/…`.

## Why this can't go on Vercel

Vercel hosts serverless functions — they can't run system binaries like
`yt-dlp`/`ffmpeg`, have short execution time limits, and have no persistent
disk. This app needs a real, always-on server. **Deploy it to Render,
Railway, or Fly.io instead** (all support Docker and are free/cheap for
small personal use). Vercel is not part of this setup.

## Deploy to Render (recommended — easiest)

1. Push this whole folder to a GitHub repo.
2. Go to [render.com](https://render.com) → **New +** → **Web Service**.
3. Connect your GitHub repo.
4. Render will detect the `Dockerfile` automatically — leave build settings
   as default.
5. Under **Environment**, add:
   - `SITE_PASSCODE` = a passcode of your choice (share this with your
     friends/family, not publicly)
6. Click **Create Web Service**. First build takes a few minutes (installing
   yt-dlp/ffmpeg). Once live, Render gives you a URL like
   `https://videovault-xxxx.onrender.com` — share that link + the passcode
   with your group.

**Free tier note:** Render's free web services spin down after inactivity
and take ~30–60s to wake back up on the next visit. Fine for occasional
personal use; upgrade to a paid instance if that's annoying.

After you pull this cookie-fix commit, **redeploy** the web service so the
new backend is live, then **clear the old session** in the app and paste a
fresh Facebook/Instagram export.

## Deploy to Railway (alternative)

1. Push to GitHub.
2. [railway.app](https://railway.app) → **New Project** → **Deploy from
   GitHub repo**.
3. Railway auto-detects the `Dockerfile`.
4. Add the `SITE_PASSCODE` environment variable in the service settings.
5. Deploy — Railway gives you a public URL.

## Running locally / on Termux

```bash
cd backend
npm install
# create a .env file (see .env.example) with SITE_PASSCODE set,
# or export it directly:
export SITE_PASSCODE=your-passcode-here
npm start
```

Then open `http://localhost:3001` — you'll land on the passcode screen first.

If `SITE_PASSCODE` is left unset, the app runs with **no gate** (open to
anyone who reaches it) — only do this for strictly local/private use.

You still need `yt-dlp` and `ffmpeg` on the PATH (`pip install -U yt-dlp`).

## How the passcode gate works

- One shared passcode for your whole group (set via `SITE_PASSCODE`).
- On success, the browser gets an httpOnly session cookie valid 30 days.
- Sessions are stored in memory — restarting the server logs everyone out
  (they just re-enter the passcode).
- This is intentionally simple: one shared login, not per-person accounts.
  If you later want each person to have their own private Facebook session
  instead of one shared one, that needs a real auth system (e.g. Supabase
  Auth + a per-user cookie table) — a bigger upgrade, ask if you want that
  built out.

## Project structure

```
videovault/
├── Dockerfile            # for Render/Railway/Fly deployment
├── .env.example
├── backend/
│   ├── server.js          # Express API + auth + yt-dlp wrapper
│   └── package.json
├── frontend/
│   ├── login.html          # passcode screen
│   └── index.html          # main app
└── README.md
```
