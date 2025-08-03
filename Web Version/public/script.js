const $ = id => document.getElementById(id);

// UI Elements
const input = $("playlistInput");
const saveBtn = $("savePlaylistBtn");
const fetchBtn = $("submitPlaylist");
const playlistList = $("savedPlaylistList");
const trackList = $("track-list");
const bigPlayBtn = document.querySelector(".center-controls .play");
const smallPlayBtn = $("playPauseBtn");
const shuffleBtn = document.querySelector(".shuffle");
const repeatBtn = document.querySelector(".repeat");
const prevBtns = [...document.querySelectorAll(".prev, #prevBtn")];
const nextBtns = [...document.querySelectorAll(".next, #nextBtn")];
const seekBar = $("seek-bar");
const curTimeTxt = $("current-time");
const durTimeTxt = $("total-duration");
const volumeBar = document.querySelector(".volume-bar");
const titleSpan = document.querySelector(".left-info .title");
const artistSpan = document.querySelector(".left-info .artist");

const audio = new Audio();
audio.volume = 1;

let currentTracks = [];
let currentIndex = 0;
let shuffleMode = false;
let repeatMode = "none";  // none | all | one
let playToken = 0;        // used to abort old play requests
let seeking = false;

// ⏱️ Format seconds to MM:SS
const formatTime = sec => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;

// 🔄 Play/Pause SVG
const getIcon = type => type === "pause" ?
  `<svg viewBox="0 0 512 512" width="40"><circle fill="#1db954" cx="256" cy="256" r="256"/><g fill="black"><rect x="180" y="150" width="40" height="200" rx="8"/><rect x="292" y="150" width="40" height="200" rx="8"/></g></svg>`
  :
  `<svg viewBox="0 0 512 512" width="40"><circle fill="#1db954" cx="256" cy="256" r="256"/><polygon fill="black" points="200,160 352,256 200,352"/></svg>`;

function updateButtons(state) {
  bigPlayBtn.innerHTML = getIcon(state);
  smallPlayBtn.innerHTML = getIcon(state);
}

function showTrack(title, artist) {
  titleSpan.textContent = title;
  artistSpan.textContent = artist;
  titleSpan.parentElement.style.display = "flex";
}

// ▶️ Play a specific track
async function playTrack(index) {
  const track = currentTracks[index];
  if (!track) return;

  currentIndex = index;
  const token = ++playToken;

  try {
    const res = await fetch("http://localhost:5000/api/youtube", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: `${track.title} ${track.artist}` })
    });
    const { videoId } = await res.json();
    if (playToken !== token) return;

    audio.src = `http://localhost:5000/api/stream/${videoId}`;
    await audio.play();
    if (playToken !== token) return;

    updateButtons("pause");
    showTrack(track.title, track.artist);
  } catch (err) {
    console.error(err);
    alert("Could not play this track.");
  }
}

// 🖼️ Render track table
function renderTracks(tracks) {
  trackList.innerHTML = "";
  tracks.forEach((t, i) => {
    const row = document.createElement("tr");
    row.innerHTML = `
      <td class="track-index">${i + 1}</td>
      <td>${t.title}<br><small>${t.artist}</small></td>
      <td>${t.album}</td>
      <td>${t.added}</td>
      <td>${t.duration}</td>`;
    row.onclick = () => playTrack(i);
    trackList.appendChild(row);
  });
}

// ▶️ Next track logic
function nextTrack() {
  if (repeatMode === "one") return playTrack(currentIndex);

  let next = currentIndex;
  if (shuffleMode) {
    do { next = Math.floor(Math.random() * currentTracks.length); }
    while (next === currentIndex && currentTracks.length > 1);
  } else {
    next++;
    if (next >= currentTracks.length) {
      if (repeatMode === "all") next = 0;
      else return;
    }
  }
  playTrack(next);
}

// ⏪ Prev track
function prevTrack() {
  currentIndex = currentIndex <= 0
    ? (repeatMode === "all" ? currentTracks.length - 1 : 0)
    : currentIndex - 1;
  playTrack(currentIndex);
}

/* ───── Button Listeners ───── */
bigPlayBtn.onclick = smallPlayBtn.onclick = () => {
  if (!audio.src) return;
  if (audio.paused) audio.play(), updateButtons("pause");
  else audio.pause(), updateButtons("play");
};

prevBtns.forEach(btn => btn.onclick = prevTrack);
nextBtns.forEach(btn => btn.onclick = nextTrack);

shuffleBtn.onclick = () => {
  shuffleMode = !shuffleMode;
  shuffleBtn.classList.toggle("glow", shuffleMode);
};

repeatBtn.onclick = () => {
  // Cycle through repeat modes: none → all → one → none
  repeatMode = repeatMode === "none" ? "all" :
               repeatMode === "all"  ? "one" : "none";

  // Glow effect for active states
  repeatBtn.classList.toggle("glow", repeatMode !== "none");

    const img = repeatBtn.querySelector("img");
  if (repeatMode === "one") {
    img.src = "icons/repeat-one.svg";  // 👈 only if you have this icon
  } else {
    img.src = "icons/repeat.svg";      // default icon
  }
};

// 📈 Seek & Time
seekBar.oninput = () => {
  if (!audio.duration) return;
  seeking = true;
  curTimeTxt.textContent = formatTime((seekBar.value / 100) * audio.duration);
};
seekBar.onchange = () => {
  if (!audio.duration) return;
  audio.currentTime = (seekBar.value / 100) * audio.duration;
  seeking = false;
};
audio.ontimeupdate = () => {
  if (!audio.duration || seeking) return;
  seekBar.value = (audio.currentTime / audio.duration) * 100;
  curTimeTxt.textContent = formatTime(audio.currentTime);
  durTimeTxt.textContent = formatTime(audio.duration);
};
audio.onended = nextTrack;
volumeBar.oninput = () => audio.volume = parseFloat(volumeBar.value);

// 📥 Playlist Loading & Saving
function loadPlaylist(url, saveToSidebar) {
  if (!url) return alert("Paste a playlist link first!");

  fetch("http://localhost:5000/api/playlist", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url })
  })
    .then(r => r.json())
    .then(data => {
      currentTracks = data.tracks;
      currentIndex = shuffleMode ? Math.floor(Math.random() * data.tracks.length) : 0;
      renderTracks(data.tracks);
      document.querySelector(".playlist-header h1").textContent = data.name;
      if (saveToSidebar) savePlaylistToSidebar(data.name, url);
    })
    .catch(err => { console.error(err); alert("Failed to load playlist/Official Playlists cannot be fetched"); });
}

function savePlaylistToSidebar(name, url) {
  const li = document.createElement("li");
  li.className = "saved-playlist";
  li.dataset.url = url;

  const span = document.createElement("span");
  span.textContent = name;
  li.style.display = "flex";
  li.style.alignItems = "center";
  span.style.flex = "1";  // Ensures it takes up the available space

  span.onclick = () => loadPlaylist(url, false);

  const del = document.createElement("button");
  del.textContent = "−";
  del.style.cssText = `
  margin-left:10px;
  background:none;
  color:#888;
  border:none;
  cursor:pointer;
  font-size:1.2rem
  `;
  del.onclick = e => { e.stopPropagation(); playlistList.removeChild(li); };

  li.append(span, del);
  playlistList.appendChild(li);
}

// 📌 Put this in place of the old saveBtn.onclick
saveBtn.onclick = () => {
  const url = input.value.trim();
  if (!url) return alert("Paste a playlist link first!");

  // fetch only playlist metadata so we can show its name
  fetch("http://localhost:5000/api/playlist", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url })
  })
    .then(r => r.json())
    .then(data => {
      savePlaylistToSidebar(data.name, url);   // 🌟 add to sidebar only
      input.value = "";                        // 🔄 clear the field
    })
    .catch(err => {
      console.error(err);
      alert("Could not save this playlist.");
    });
};


fetchBtn.onclick = () => {
  loadPlaylist(input.value.trim(), false);
};

$("loginSpotify").onclick = () => {
  window.location.href = "http://localhost:5000/login";
};

window.addEventListener('DOMContentLoaded', () => {
  fetch('http://127.0.0.1:5000/api/me')
    .then(res => res.ok ? res.json() : null)
    .then(data => {
      if (data && data.display_name) {
        const loginBtn = document.getElementById('loginSpotify');
        const userSection = document.getElementById('spotifyUserSection');

        // Update the login button to show the username
        loginBtn.textContent = data.display_name;
        loginBtn.disabled = true;
        loginBtn.style.cursor = "default";
        loginBtn.style.opacity = "0.8";

        // Create and append logout button just below it
        const logoutBtn = document.createElement("button");
        logoutBtn.textContent = "Logout";
        logoutBtn.style.cssText = `
          margin-top: 6px;
          background: #1db954;
          color: white;
          padding: 5px 10px;
          border: none;
          border-radius: 4px;
          cursor: pointer;
          display: block;
          margin-left: auto;
          margin-right: auto;
          font-size: 0.85rem;
        `;
        logoutBtn.onclick = () => {
          fetch("http://localhost:5000/logout").then(() => location.reload());
        };

        userSection.appendChild(logoutBtn);

        // 🌟 Fetch user's playlists and display them
        fetch('http://127.0.0.1:5000/api/my-playlists')
          .then(res => res.json())
          .then(data => {
            if (data.playlists) {
              data.playlists.forEach(p =>
                savePlaylistToSidebar(p.name, p.url)
              );
            }
          });
      }
    });
});

const likedLi = document.createElement("li");
likedLi.className = "saved-playlist";
likedLi.textContent = "❤️ Liked Songs";
likedLi.onclick = () => {
  fetch("http://localhost:5000/api/liked")
    .then(res => res.json())
    .then(data => {
      currentTracks = data.tracks;
      currentIndex = shuffleMode ? Math.floor(Math.random() * data.tracks.length) : 0;
      renderTracks(data.tracks);
      document.querySelector(".playlist-header h1").textContent = data.name;
    })
    .catch(err => {
      console.error(err);
      alert("Failed to load liked songs. Please Login to Spotify first.");
    });
};

playlistList.prepend(likedLi);

if (data && data.display_name) {
  const loginBtn = document.getElementById('loginSpotify');
  const userSection = document.getElementById('spotifyUserSection');

  loginBtn.textContent = data.display_name;
  loginBtn.disabled = true;
  loginBtn.style.cursor = "default";
  loginBtn.style.opacity = "0.8";

  // 🌟 Create Logout Button only once
  const logoutBtn = document.createElement("button");
  logoutBtn.textContent = "Logout";
  logoutBtn.style.cssText = `
    margin-top: 8px;
    background: #333;
    color: white;
    border: none;
    padding: 6px 12px;
    border-radius: 5px;
    cursor: pointer;
  `;
  logoutBtn.onclick = () => {
    fetch("http://localhost:5000/logout").then(() => location.reload());
  };

  userSection.appendChild(logoutBtn);
}