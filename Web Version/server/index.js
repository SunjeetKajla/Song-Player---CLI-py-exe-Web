/* ─────────────── ENV / LIBS ───────────────────────────── */
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");
const querystring = require("querystring");
const SpotifyWeb = require("spotify-web-api-node");
const yts = require("yt-search");
const ytdl = require("@distube/ytdl-core");
const pump = require("pump");

const app = express();
const PORT = process.env.PORT || 5000;

let userSpotify = null;

app.use(cors());
app.use(express.json());

/* ─────────────── 1.  TWO  SPOTIFY CLIENTS ─────────────── */
const creds = {
  clientId: process.env.SPOTIFY_CLIENT_ID,
  clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
  redirectUri: process.env.SPOTIFY_REDIRECT_URI
};

// A)  app‑only token (for public playlist reads)
const spotifyApp = new SpotifyWeb(creds);

// B)  per‑user tokens (set only after login)
const spotifyUser = new SpotifyWeb(creds);

async function refreshAppToken() {
  try {
    const { body } = await spotifyApp.clientCredentialsGrant();
    spotifyApp.setAccessToken(body.access_token);
    console.log("✅ app‑only token refreshed");
    setTimeout(refreshAppToken, (body.expires_in - 300) * 1000);
  } catch (e) {
    console.error("❌ app token refresh failed", e.body || e);
  }
}
refreshAppToken();

/* ─────────────── 1‑b  LOGIN & CALLBACK ────────────────── */
app.get("/login", (_req, res) => {
  const scopes = "playlist-read-private user-read-private user-library-read";
  const qs = querystring.stringify({
    response_type: "code",
    client_id: creds.clientId,
    scope: scopes,
    redirect_uri: creds.redirectUri,
    show_dialog: true   // 🔥 forces account selection!
  });
  console.log("[LOGIN] redirecting to Spotify with redirect_uri =", creds.redirectUri);
  res.redirect(`https://accounts.spotify.com/authorize?${qs}`);
});

app.get("/logout", (_req, res) => {
  userSpotify = null;
  spotifyUser.setAccessToken("");
  spotifyUser.setRefreshToken("");
  res.sendStatus(200);
});

app.get("/api/my-playlists", async (_req, res) => {
  if (!spotifyUser.getAccessToken()) {
    return res.status(401).json({ error: "Not logged in" });
  }

  try {
    let playlists = [];
    let offset = 0;
    const limit = 50;

    while (true) {
      const { body } = await spotifyUser.getUserPlaylists({ limit, offset });
      playlists.push(...body.items);
      if (body.items.length < limit) break;
      offset += limit;
    }

    const userId = (await spotifyUser.getMe()).body.id;
    const ownedPlaylists = playlists.filter(p => p.owner && p.owner.id === userId);

    const simplified = ownedPlaylists.map(p => ({
      name: p.name,
      url: p.external_urls.spotify
    }));

    res.json({ playlists: simplified });
  } catch (e) {
    console.error("🔴 error fetching user playlists", e.body || e);
    res.status(500).json({ error: "Could not fetch playlists" });
  }
});

app.get("/api/liked", async (req, res) => {
  if (!spotifyUser.getAccessToken()) {
    return res.status(401).json({ error: "Not logged in" });
  }

  try {
    let tracks = [];
    for (let off = 0, lim = 50, tot = 1; off < tot; off += lim) {
      const r = await spotifyUser.getMySavedTracks({ offset: off, limit: lim });
      tot = r.body.total;
      tracks.push(...r.body.items.map(x => ({
        title   : x.track.name,
        artist  : x.track.artists.map(a => a.name).join(", "),
        album   : x.track.album.name,
        added   : (x.added_at || "").split("T")[0],
        duration: mmss(x.track.duration_ms)
      })));
    }

    res.json({ name: "Liked Songs", tracks });
  } catch (e) {
    console.error("🔴 liked songs fetch error", e.body || e);
    res.status(500).json({ error: "Failed to fetch liked songs" });
  }
});

app.get("/callback", async (req, res) => {
  const code = req.query.code;
  if (!code) return res.status(400).send("Missing code");

  try {
    const { body } = await spotifyUser.authorizationCodeGrant(code);
    spotifyUser.setAccessToken(body.access_token);
    spotifyUser.setRefreshToken(body.refresh_token);
    console.log("✅ user token set (expires in", body.expires_in, "s)");

    // Auto‑refresh for user token
    setTimeout(async () => {
      try {
        const data = await spotifyUser.refreshAccessToken();
        spotifyUser.setAccessToken(data.body.access_token);
        console.log("🔄 user token refreshed");
      } catch (e) {
        console.error("❌ user token refresh failed", e.body || e);
      }
    }, (body.expires_in - 300) * 1000);

    res.redirect("http://127.0.0.1:3000/Web%20Version/public/index.html?loggedIn=true");
  } catch (e) {
    console.error("❌ login failed", e.body || e);
    res.status(500).send("Spotify login failed");
  }
});

/* expose profile when logged in */
app.get("/api/me", async (_req, res) => {
  if (!spotifyUser.getAccessToken()) return res.status(401).json({ error: "Not logged in" });
  try {
    const me = await spotifyUser.getMe();
    res.json(me.body);
  } catch (e) {
    res.status(401).json({ error: "User token invalid" });
  }
});

/* ─────────────── HELPERS ──────────────────────────────── */
const ensureAppToken = res => {
  if (!spotifyApp.getAccessToken()) {
    res.status(503).json({ error: "Spotify token not ready yet" });
    return false;
  }
  return true;
};

const mmss = ms =>
  `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, "0")}`;

/* ─────────────── 2.  API ROUTES ───────────────────────── */
app.post("/api/playlist", async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: "Missing playlist URL" });

  let id;
  try {
    const u = new URL(url);
    const parts = u.pathname.split("/");
    const idx = parts.indexOf("playlist");
    id = idx !== -1 ? parts[idx + 1] : null;
  } catch {
    id = null;
  }

  if (!id) return res.status(400).json({ error: "Invalid playlist URL" });

  try {
    // use user token if logged in, otherwise fallback to app token
    const client = spotifyUser.getAccessToken() ? spotifyUser : spotifyApp;
    const meta = await client.getPlaylist(id);
    const name = meta.body.name;

    let tracks = [];
    for (let off = 0, lim = 100, tot = 1; off < tot; off += lim) {
      const r = await client.getPlaylistTracks(id, { offset: off, limit: lim });
      tot = r.body.total;
      tracks.push(...r.body.items.map(x => ({
        title: x.track.name,
        artist: x.track.artists.map(a => a.name).join(", "),
        album: x.track.album.name,
        added: (x.added_at || "").split("T")[0],
        duration: mmss(x.track.duration_ms)
      })));
    }

    res.json({ name, tracks });
  } catch (e) {
    console.error("🔴 playlist fetch error", e.body || e);
    res.status(500).json({ error: "Spotify could not access this playlist (private or region‑locked)" });
  }
});

app.post("/api/youtube", async (req, res) => {
  const { query } = req.body;
  if (!query) return res.status(400).json({ error: "Missing query" });

  try {
    const { videos } = await yts(query);
    if (!videos.length) return res.status(404).json({ error: "No video found" });
    res.json({ videoId: videos[0].videoId, title: videos[0].title });
  } catch (e) {
    console.error("🔴 yt-search error", e);
    res.status(500).json({ error: "YouTube search failed" });
  }
});

app.get("/api/stream/:id", async (req, res) => {
  const { id } = req.params;
  if (!ytdl.validateID(id)) return res.status(400).send("Bad video id");

  const range = req.headers.range || "bytes=0-";
  const info = await ytdl.getInfo(id);
  const fmt = ytdl.chooseFormat(info.formats, { quality: "highestaudio", filter: "audioonly" });

  const [start, end] = range.replace(/bytes=/, "").split("-").map(Number);
  const total = Number(fmt.contentLength);
  const chunkEnd = end || total - 1;
  const size = chunkEnd - start + 1;

  res.writeHead(206, {
    "Content-Range": `bytes ${start}-${chunkEnd}/${total}`,
    "Accept-Ranges": "bytes",
    "Content-Length": size,
    "Content-Type": "audio/webm"
  });

  pump(
    ytdl.downloadFromInfo(info, { quality: fmt.itag, range: { start, end: chunkEnd } }),
    res
  );
});

/* ─────────────── 3.  STATIC FRONTEND ──────────────────── */
app.use(express.static(path.join(__dirname, "../public")));
app.get(/^\/(?!api\/).*/, (_req, res) =>
  res.sendFile(path.join(__dirname, "../public/index.html"))
);

/* ─────────────── 4.  START SERVER ─────────────────────── */
app.listen(PORT, () =>
  console.log(`🎧  S‑Potify backend running  →  http://127.0.0.1:${PORT}`)
);
