# Soundcloud WAV

A dark, minimalist audio downloader. Paste a **YouTube** or **SoundCloud** URL and get back lossless **.wav** files — right in your browser.

---

## System Dependencies

These must be installed **before** running the app.

### 1. yt-dlp

> Download the binary from [https://github.com/yt-dlp/yt-dlp/releases](https://github.com/yt-dlp/yt-dlp/releases)
> and place it on your system `PATH`, or note its absolute path for use below.

**macOS / Linux (via pip):**
```bash
pip install yt-dlp
```

**Windows (via winget):**
```powershell
winget install yt-dlp
```

### 2. ffmpeg

**macOS (via Homebrew):**
```bash
brew install ffmpeg
```

**Windows (via winget):**
```powershell
winget install ffmpeg
```

**Linux (Ubuntu/Debian):**
```bash
sudo apt install ffmpeg
```

Verify both are installed:
```bash
yt-dlp --version
ffmpeg -version
```

---

## Installation & Setup

```bash
# 1. Enter the project directory
cd soundcloud-wav

# 2. Install Node.js dependencies
npm install

# 3. Start the server
npm start
```

Open **[http://localhost:3000](http://localhost:3000)** in your browser.

---

## Environment Variables

| Variable      | Default          | Description                              |
|---------------|------------------|------------------------------------------|
| `PORT`        | `3000`           | HTTP port the server listens on          |
| `YTDLP_PATH`  | `yt-dlp`         | Absolute path to the yt-dlp binary       |
| `FFMPEG_PATH` | `ffmpeg`         | Absolute path to the ffmpeg binary       |
| `TMP_DIR`     | OS temp dir      | Directory for temporary audio files      |

**Example** (Windows PowerShell):
```powershell
$env:YTDLP_PATH="C:\tools\yt-dlp.exe"
$env:FFMPEG_PATH="C:\tools\ffmpeg\bin\ffmpeg.exe"
npm start
```

**Example** (macOS/Linux):
```bash
YTDLP_PATH=/usr/local/bin/yt-dlp FFMPEG_PATH=/usr/local/bin/ffmpeg npm start
```

---

## Supported URLs

- **YouTube** videos and playlists  
  `https://www.youtube.com/watch?v=...`  
  `https://www.youtube.com/playlist?list=...`

- **SoundCloud** tracks and playlists  
  `https://soundcloud.com/artist/track`  
  `https://soundcloud.com/artist/sets/playlist`

---

## Output Format

All audio is converted to:
- **Format:** WAV (PCM)
- **Sample rate:** 44,100 Hz
- **Bit depth:** 16-bit
- **Channels:** Stereo

---

## Tech Stack

- **Backend:** Node.js + Express
- **Downloader:** yt-dlp (via `child_process`)
- **Converter:** ffmpeg
- **Progress:** Server-Sent Events (SSE)
- **Frontend:** Vanilla HTML / CSS / JS
