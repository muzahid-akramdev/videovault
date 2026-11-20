# VideoVault

Paste a link, see available formats, download the file. Built on [yt-dlp](https://github.com/yt-dlp/yt-dlp) + ffmpeg, with a passcode gate so only your friends/family can use it.

- **Only download content you own or have the right to download.**
- **Facebook & Instagram need a logged-in session.** Paste browser cookies (exported via Cookie-Editor) in the app's "Facebook / Instagram Login" panel. For your own old Facebook videos, Facebook's official Download Your Information export is more reliable — use this as a complement.

## Cookies look "active" but download still fails

yt-dlp needs the login cookies, not a whole-browser dump:

| Site | Required cookies |
| --- | --- |
| Facebook | `c_user` **and** `xs` |
| Instagram | `sessionid` |
| YouTube | `SID` / `__Secure-1PSID` — YouTube may still bot-check |

Export **on the facebook.com / instagram.com tab**, Netscape or JSON (JSON is converted to Netscape automatically). After saving, the badge must say **Logged in · Facebook** (or Instagram), not just a number.

Use a canonical URL when you can: `facebook.com/reel/…` or `facebook.com/watch/?v=…`, not `facebook.com/share/v/…`.

## Deploy to Render (recommended)

This app can't run on Vercel — serverless functions can't run `yt-dlp`/`ffmpeg` binaries or keep persistent disk. Use a Docker host instead.

1. Push to GitHub, go to [render.com](https://render.com) → **New +** → **Web Service**, connect the repo (the `Dockerfile` is detected automatically).
2. Leave env empty for no passcode, or add `SITE_GATE=1` and `SITE_PASSCODE` for the lock screen.
3. Create the service. First build takes a few minutes.

Free tier services spin down after inactivity and take ~30–60s to wake.

The passcode is one shared login for the group (`SITE_PASSCODE`); a successful entry sets a 30-day httpOnly cookie, and restarting the server logs everyone out.

## Running locally

```bash
cd backend
npm install
export SITE_PASSCODE=your-passcode-here
npm start
```

Open `http://localhost:3001`. You also need `yt-dlp` and `ffmpeg` on the PATH (`pip install -U yt-dlp`). If `SITE_PASSCODE` is unset the app runs with no gate — only for strictly local use.

## Project structure

```
├── Dockerfile
├── .env.example
├── backend/   # Express API + auth + yt-dlp wrapper
└── frontend/  # login.html (passcode) + index.html (app)
```
