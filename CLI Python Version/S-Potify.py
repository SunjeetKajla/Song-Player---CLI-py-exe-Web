#!/usr/bin/env python3
print("""
S-Potify v0.8  ──  CLI Music Player
───────────────────────────────────
Features
    • YouTube playback (yt-dlp + VLC)
    • Text-file playlists
    • Commands:
        p          pause / resume
        rs         restart track
        rw N       rewind   N seconds
        ff N       forward  N seconds
        nx         next track
        pr         previous track
        lp         toggle loop current track
        sh         toggle shuffle playlist
        vol N      set volume 0-100 %
        add N      queue playlist-song #N to play next
        + title    queue by free-text song title
        q          stop / exit playlist
""")

import os
import sys
import time
import queue
import random
import ctypes
import threading
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent

# --------------------------------------------------------------------------- #
#  Third-party libraries
# --------------------------------------------------------------------------- #
try:
    import yt_dlp
    import vlc
    if sys.platform.startswith("win"):
        os.add_dll_directory(r"C:\Program Files\VideoLAN\VLC")
except ImportError:
    sys.exit("❌  Run  ➜  pip install yt-dlp python-vlc")

# --------------------------------------------------------------------------- #
#  Globals / Runtime State
# --------------------------------------------------------------------------- #
COMMANDS          = queue.Queue()

SHUFFLE_MODE      = False          # shuffle flag
LAST_PLAYED       = []             # stack for "prev" in shuffle mode
INDEX_QUEUE       = []             # queued via add N
NAME_QUEUE        = []             # queued via + song name
CURRENT_PLAYLIST  = None           # reference to active playlist (list[str])
CURRENT_TITLE     = ""             # track title for timer / title-bar updates

# --------------------------------------------------------------------------- #
#  Utility Functions
# --------------------------------------------------------------------------- #
def set_title(text: str) -> None:
    """Set console window title (cross-platform)."""
    if os.name == "nt":
        ctypes.windll.kernel32.SetConsoleTitleW(text)
    else:
        sys.stdout.write(f"\33]0;{text}\a")
        sys.stdout.flush()


def format_time(ms: int) -> str:
    """Convert milliseconds → MM:SS string."""
    minutes, seconds = divmod(max(ms, 0) // 1000, 60)
    return f"{minutes:02}:{seconds:02}"


def search_first_audio_url(query: str) -> tuple[str, str]:
    """
    Search YouTube and return (title, audio_stream_url)
    using yt-dlp with ytsearch1: syntax.
    """
    ydl_opts = {
        "format":        "bestaudio",
        "quiet":         True,
        "default_search": "ytsearch1",
        "skip_download": True,
    }

    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info   = ydl.extract_info(query, download=False)
        entry  = info["entries"][0] if "entries" in info else info
        title  = entry["title"]
        stream = entry["url"]

        return title, stream


# --------------------------------------------------------------------------- #
#  VLC Player Wrapper
# --------------------------------------------------------------------------- #
class VLCPlayer:
    """Thin wrapper around python-vlc for simplified control."""

    def __init__(self, url: str) -> None:
        self.instance = vlc.Instance("--no-video", "--quiet")
        self.media    = self.instance.media_new(url)
        self.player   = self.instance.media_player_new()
        self.player.set_media(self.media)

    # ― basic control ― #
    def play(self) -> None:
        self.player.play()

    def pause_toggle(self) -> None:
        self.player.pause()

    def stop(self) -> None:
        self.player.stop()

    # ― navigation ― #
    def restart(self) -> None:
        self.player.stop()
        self.player.set_time(0)
        self.player.play()

    def seek_rel(self, seconds: int) -> None:
        new_time = max(self.player.get_time() + seconds * 1000, 0)
        self.player.set_time(new_time)

    # ― audio ― #
    def set_volume(self, percent: int) -> None:
        self.player.audio_set_volume(max(0, min(100, percent)))

    # ― status ― #
    def is_finished(self) -> bool:
        return self.player.get_state() in (
            vlc.State.Ended,
            vlc.State.Stopped,
            vlc.State.Error
        )


# --------------------------------------------------------------------------- #
#  Command Listener (runs in a daemon thread)
# --------------------------------------------------------------------------- #
def command_listener() -> None:
    prompt = (
        "\n♫ Command [p, rs, rw N, ff N, nx, pr, lp, sh, vol N, "
        "add N, + title, q]: "
    )
    while True:
        COMMANDS.put(input(prompt).strip())


# --------------------------------------------------------------------------- #
#  Core Track Player
# --------------------------------------------------------------------------- #
def play_one(query: str) -> str:
    """
    Play a single track (search string or direct URL).

    Returns:
        'next'   user pressed nx
        'prev'   user pressed pr
        'done'   track naturally ended
        'abort'  user pressed q
    """
    global CURRENT_TITLE

    # — fetch metadata — #
    try:
        CURRENT_TITLE, stream_url = search_first_audio_url(query)
    except Exception as err:
        print("❌  Search failed:", err)
        set_title("S-Potify")
        return "done"

    # — start playback — #
    print(f"\n▶️  Now playing: {CURRENT_TITLE}")
    player      = VLCPlayer(stream_url)
    player.play()

    loop_on     = False
    stop_timer  = threading.Event()

    # ― background timer updates window title every second ― #
    def timer_thread() -> None:
        while not stop_timer.is_set():
            cur   = player.player.get_time()
            total = player.player.get_length()
            if cur > 0 and total > 0:
                set_title(
                    f"S-Potify | {CURRENT_TITLE} | "
                    f"{format_time(cur)} / {format_time(total)}"
                )
            time.sleep(1)

    threading.Thread(target=timer_thread, daemon=True).start()

    # — command/event loop — #
    while True:
        try:
            cmd = COMMANDS.get(timeout=0.3)
        except queue.Empty:
            # track ended?
            if player.is_finished():
                if loop_on:
                    player.restart()
                    continue
                stop_timer.set()
                set_title("S-Potify")
                return "done"
            continue

        tokens = cmd.split()
        head   = tokens[0] if tokens else ""

        # ― playback control ― #
        if head == "p":
            player.pause_toggle()

        elif head == "rs":
            player.restart()

        elif head == "rw":
            if len(tokens) == 2 and tokens[1].isdigit():
                player.seek_rel(-int(tokens[1]))
            else:
                print("rw <seconds>")

        elif head == "ff":
            if len(tokens) == 2 and tokens[1].isdigit():
                player.seek_rel(int(tokens[1]))
            else:
                print("ff <seconds>")

        elif head in ("nx", "next"):
            player.stop()
            stop_timer.set()
            set_title("S-Potify")
            return "next"

        elif head in ("pr", "prev"):
            player.stop()
            stop_timer.set()
            set_title("S-Potify")
            return "prev"

        # ― mode toggles ― #
        elif head == "lp":
            loop_on = not loop_on
            print("\n🔁 Loop", "ON" if loop_on else "OFF")

        elif head == "sh":
            global SHUFFLE_MODE
            SHUFFLE_MODE = not SHUFFLE_MODE
            print(f"\n🔀 Shuffle {'ON' if SHUFFLE_MODE else 'OFF'}")

        # ― audio ― #
        elif head == "vol":
            if len(tokens) == 2 and tokens[1].isdigit():
                val = int(tokens[1])
                player.set_volume(val)
                print(f"\n🔊 Volume set to {val}%")
            else:
                print("vol <0-100>")

        # ― queue numeric song (# in playlist) ― #
        elif head == "add":
            if CURRENT_PLAYLIST is None:
                print("\n⚠️  Not in playlist mode.")
            elif len(tokens) == 2 and tokens[1].isdigit():
                pos = int(tokens[1]) - 1
                if 0 <= pos < len(CURRENT_PLAYLIST):
                    INDEX_QUEUE.append(pos)
                    print(f"\n✅ Queued song #{pos + 1} next.")
                else:
                    print("⚠️  Index out of range.")
            else:
                print("add <song-number>")

        # ― queue by free-text name ― #
        elif head == "+":
            name = cmd[1:].strip()
            if name:
                NAME_QUEUE.append(name)
                print(f"\n✅ Queued “{name}” next.")
            else:
                print("⚠️  Usage: + <song name>")

        # ― abort ― #
        elif head == "q":
            player.stop()
            stop_timer.set()
            set_title("S-Potify")
            return "abort"

        else:
            print("⚠️  Unknown command.")

# --------------------------------------------------------------------------- #
#  Main Application Loop
# --------------------------------------------------------------------------- #
def main() -> None:
    print("🎧  S-Potify v0.8".center(100,"-"))
    print("Please press Enter one time after you're done reading commands to start S-Potify")
    threading.Thread(target=command_listener, daemon=True).start()

    while True:
        user_input = input("\n🎵  Song or playlist.txt [to start || Type Enter to exit]: ").strip()
        if not user_input:
            break

        parts     = user_input.split()
        file_path = SCRIPT_DIR / parts[0]

        # ― Playlist Mode ― #
        if file_path.suffix.lower() == ".txt" and file_path.is_file():
            start_idx = (
                int(parts[1]) - 1 if len(parts) > 1 and parts[1].isdigit() else 0
            )

            with file_path.open(encoding="utf-8") as fp:
                playlist = [line.strip() for line in fp if line.strip()]

            if not 0 <= start_idx < len(playlist):
                print("⚠️  Start index out of range."); continue

            global CURRENT_PLAYLIST
            CURRENT_PLAYLIST = playlist

            print(f"📜  Loaded {len(playlist)} songs — starting "
                  f"at #{start_idx + 1}")

            idx = start_idx
            while True:
                # ― Queue priority: NAME > INDEX > normal ― #
                if NAME_QUEUE:
                    query  = NAME_QUEUE.pop(0)
                    result = play_one(query)
                else:
                    result = play_one(playlist[idx])

                if result == "abort":
                    break

                # ― decide next index ― #
                if NAME_QUEUE:
                    continue                                  # name queue still pending

                if INDEX_QUEUE:
                    idx = INDEX_QUEUE.pop(0)

                elif result in ("next", "done"):
                    if SHUFFLE_MODE:
                        LAST_PLAYED.append(idx)
                        idx = random.randrange(len(playlist))
                    else:
                        idx += 1

                elif result == "prev":
                    if SHUFFLE_MODE and LAST_PLAYED:
                        idx = LAST_PLAYED.pop()
                    else:
                        idx = max(idx - 1, 0)

                if not SHUFFLE_MODE and not (0 <= idx < len(playlist)):
                    break

            CURRENT_PLAYLIST = None  # reset after leaving playlist mode

        # ― Single Song Mode ― #
        else:
            play_one(user_input)

    print("👋  Thanks for using S-Potify!")


# --------------------------------------------------------------------------- #
#  Entrypoint
# --------------------------------------------------------------------------- #
if __name__ == "__main__":
    main()
