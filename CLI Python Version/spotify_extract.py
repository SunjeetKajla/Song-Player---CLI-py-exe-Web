import spotipy
from spotipy.oauth2 import SpotifyOAuth
import os

# 🔧 Replace with your own credentials
CLIENT_ID = 'd726129fe57647e9b4603a83db959055'
CLIENT_SECRET = 'a366a828ceef4d9794c524d5b53ae9e1'
REDIRECT_URI = 'http://127.0.0.1:8888/callback'

scope = "playlist-read-private"

sp = spotipy.Spotify(auth_manager=SpotifyOAuth(
    client_id=CLIENT_ID,
    client_secret=CLIENT_SECRET,
    redirect_uri=REDIRECT_URI,
    scope=scope
))

# 🔍 Replace with your actual playlist URL or ID
playlist_link = input("Paste your Spotify playlist link: ").strip()
playlist_name=input("Enter Playlist Name:")
playlist_uri = playlist_link.split("/")[-1].split("?")[0]

results = sp.playlist_tracks(playlist_uri)
tracks = []

while results:
    for item in results['items']:
        track = item['track']
        if track is None:
            continue
        name = track['name']
        artist = track['artists'][0]['name']
        tracks.append(f"{name} {artist}")

    # check if there's a next page of results
    if results['next']:
        results = sp.next(results)
    else:
        break

# Write to file
output_path = os.path.join(os.path.dirname(__file__), f"{playlist_name}.txt")
with open(playlist_name+".txt", "w", encoding="utf-8") as f:
    f.write("\n".join(tracks))
os.remove(".cache")

print(f"✅ Saved to {playlist_name}.txt")
