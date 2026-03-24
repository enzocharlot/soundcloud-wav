/**
 * Soundcloud WAV – Express backend
 * Downloads YouTube / SoundCloud audio via yt-dlp and converts to WAV with ffmpeg.
 * Progress is streamed to the client via Server-Sent Events (SSE).
 */

const express = require('express');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { v4: uuidv4 } = require('uuid');

// ---------------------------------------------------------------------------
// Configuration  — override with environment variables
// ---------------------------------------------------------------------------
const PORT       = process.env.PORT       || 3000;
const YTDLP_PATH = process.env.YTDLP_PATH || 'yt-dlp';   // must be on PATH or absolute path
const FFMPEG_PATH = process.env.FFMPEG_PATH || 'ffmpeg';  // must be on PATH or absolute path
const TMP_DIR    = process.env.TMP_DIR    || path.join(os.tmpdir(), 'soundcloud-wav');

// Ensure temp directory exists
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// In-memory job store  { jobId -> { status, files: [], error } }
// ---------------------------------------------------------------------------
const jobs = {};

// ---------------------------------------------------------------------------
// POST /api/download  — start a download job
// ---------------------------------------------------------------------------
app.post('/api/download', (req, res) => {
  const { url } = req.body;
  if (!url || !url.trim()) {
    return res.status(400).json({ error: 'URL is required.' });
  }

  // Basic sanity check
  const validHosts = ['youtube.com', 'youtu.be', 'soundcloud.com', 'www.youtube.com', 'www.soundcloud.com', 'm.youtube.com', 'music.youtube.com'];
  let parsedUrl;
  try {
    parsedUrl = new URL(url.trim());
  } catch {
    return res.status(400).json({ error: 'Invalid URL. Please enter a valid YouTube or SoundCloud link.' });
  }
  if (!validHosts.some(h => parsedUrl.hostname === h)) {
    return res.status(400).json({ error: 'Unsupported URL. Only YouTube and SoundCloud links are supported.' });
  }

  const jobId = uuidv4();
  jobs[jobId] = { status: 'pending', files: [], error: null };

  res.json({ jobId });

  // Run async — don't await
  runDownloadJob(jobId, url.trim()).catch(err => {
    if (jobs[jobId]) {
      jobs[jobId].status = 'error';
      jobs[jobId].error = err.message;
    }
  });
});

// ---------------------------------------------------------------------------
// GET /api/progress/:jobId  — SSE stream of progress events
// ---------------------------------------------------------------------------
app.get('/api/progress/:jobId', (req, res) => {
  const { jobId } = req.params;
  if (!jobs[jobId]) {
    res.status(404).json({ error: 'Job not found.' });
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (data) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  // Poll job state and forward events
  const job = jobs[jobId];
  if (!job._listeners) job._listeners = [];
  job._listeners.push(send);

  // Replay buffered events so far
  if (job._events) {
    for (const ev of job._events) send(ev);
  }

  // If already done/error, close immediately
  if (job.status === 'done' || job.status === 'error') {
    send({ type: job.status === 'done' ? 'done' : 'error', error: job.error, files: job.files });
    res.end();
    return;
  }

  req.on('close', () => {
    if (job._listeners) {
      job._listeners = job._listeners.filter(l => l !== send);
    }
  });
});

// ---------------------------------------------------------------------------
// GET /api/file/:jobId/:filename  — serve a converted WAV file then delete it
// ---------------------------------------------------------------------------
app.get('/api/file/:jobId/:filename', (req, res) => {
  const { jobId, filename } = req.params;
  const job = jobs[jobId];
  if (!job) return res.status(404).send('Job not found.');

  // Security: only allow filenames that are part of this job
  const safeFilename = path.basename(filename);
  const filePath = path.join(TMP_DIR, jobId, safeFilename);

  if (!fs.existsSync(filePath)) {
    return res.status(404).send('File not found or already downloaded.');
  }

  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(safeFilename)}"`);
  res.setHeader('Content-Type', 'audio/wav');

  const stream = fs.createReadStream(filePath);
  stream.pipe(res);
  stream.on('end', () => {
    // Delete the file after delivery
    try { fs.unlinkSync(filePath); } catch {}
    // If all files are delivered, clean up the job directory
    const remaining = fs.readdirSync(path.join(TMP_DIR, jobId)).filter(f => f.endsWith('.wav'));
    if (remaining.length === 0) {
      try { fs.rmdirSync(path.join(TMP_DIR, jobId), { recursive: true }); } catch {}
      // Keep job metadata for a little while for debugging, clean up after 5 min
      setTimeout(() => { delete jobs[jobId]; }, 5 * 60 * 1000);
    }
  });
});

// ---------------------------------------------------------------------------
// Core download + convert logic
// ---------------------------------------------------------------------------
async function runDownloadJob(jobId, url) {
  const job = jobs[jobId];
  job._events = [];
  job.status = 'running';

  const emit = (data) => {
    job._events.push(data);
    if (job._listeners) {
      for (const send of job._listeners) {
        try { send(data); } catch {}
      }
    }
  };

  const jobDir = path.join(TMP_DIR, jobId);
  fs.mkdirSync(jobDir, { recursive: true });

  // ------------------------------------------------------------------
  // Step 1: Get track list via yt-dlp --flat-playlist --dump-json
  // ------------------------------------------------------------------
  emit({ type: 'status', message: 'Fetching track list…' });

  let trackList;
  try {
    trackList = await getTrackList(url);
  } catch (err) {
    emit({ type: 'error', error: `Failed to fetch track list: ${err.message}` });
    job.status = 'error';
    job.error = err.message;
    return;
  }

  const total = trackList.length;
  emit({ type: 'total', total });
  emit({ type: 'status', message: `Found ${total} track${total !== 1 ? 's' : ''}. Starting download…` });

  // ------------------------------------------------------------------
  // Step 2: Download + convert each track
  // ------------------------------------------------------------------
  const completedFiles = [];

  for (let i = 0; i < trackList.length; i++) {
    const track = trackList[i];
    const trackUrl = track.url || track.webpage_url || url;
    const trackTitle = track.title || `track_${i + 1}`;
    const safeTitle = sanitizeFilename(trackTitle);

    emit({ type: 'track_start', index: i, title: trackTitle, total });

    try {
      const wavFile = await downloadAndConvert(trackUrl, safeTitle, jobDir, jobId, i, total, emit);
      completedFiles.push({ filename: path.basename(wavFile), title: trackTitle });
      job.files.push({ filename: path.basename(wavFile), title: trackTitle });
      emit({ type: 'track_done', index: i, filename: path.basename(wavFile), title: trackTitle, total });
    } catch (err) {
      emit({ type: 'track_error', index: i, title: trackTitle, error: err.message });
      // Continue with remaining tracks
    }
  }

  job.status = 'done';
  emit({ type: 'done', files: completedFiles });

  // Close all SSE connections
  if (job._listeners) {
    for (const send of job._listeners) {
      try { /* connection will naturally time out */ } catch {}
    }
  }
}

// ---------------------------------------------------------------------------
// Fetch flat track list
// ---------------------------------------------------------------------------
function getTrackList(url) {
  return new Promise((resolve, reject) => {
    const args = [
      '--flat-playlist',
      '--dump-json',
      '--no-warnings',
      '--ignore-errors',
      url
    ];

    const proc = spawn(YTDLP_PATH, args);
    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });

    proc.on('error', (err) => {
      reject(new Error(`yt-dlp not found. Please install yt-dlp. (${err.message})`));
    });

    proc.on('close', (code) => {
      if (!stdout.trim()) {
        return reject(new Error(stderr || 'No tracks found for the given URL.'));
      }

      // yt-dlp dumps one JSON object per line
      const lines = stdout.trim().split('\n').filter(Boolean);
      const tracks = [];
      for (const line of lines) {
        try {
          const obj = JSON.parse(line);
          tracks.push(obj);
        } catch {}
      }

      if (tracks.length === 0) {
        return reject(new Error('No tracks could be parsed from yt-dlp output.'));
      }

      resolve(tracks);
    });
  });
}

// ---------------------------------------------------------------------------
// Download a single track and convert to WAV via ffmpeg
// ---------------------------------------------------------------------------
function downloadAndConvert(url, safeTitle, jobDir, jobId, index, total, emit) {
  return new Promise((resolve, reject) => {
    const outputTemplate = path.join(jobDir, `${safeTitle}.%(ext)s`);
    const wavPath = path.join(jobDir, `${safeTitle}.wav`);

    // Use yt-dlp to download best audio, pipe to ffmpeg for WAV conversion
    const ytdlpArgs = [
      '--no-playlist',
      '--no-warnings',
      '--ignore-errors',
      '-f', 'bestaudio',
      '--output', outputTemplate,
      '--newline',        // force progress on new lines
      '--progress',
      url
    ];

    const proc = spawn(YTDLP_PATH, ytdlpArgs);
    let stderr = '';

    proc.stdout.on('data', (data) => {
      const text = data.toString();
      // Parse yt-dlp download percentage lines like "[download]  42.3% ..."
      const match = text.match(/\[download\]\s+([\d.]+)%/);
      if (match) {
        const pct = parseFloat(match[1]);
        emit({ type: 'track_progress', index, percent: pct, stage: 'download' });
      }
    });

    proc.stderr.on('data', d => { stderr += d.toString(); });

    proc.on('error', (err) => {
      reject(new Error(`yt-dlp error: ${err.message}`));
    });

    proc.on('close', (code) => {
      if (code !== 0 && code !== null) {
        // Some formats exit with non-zero even on success — check if file exists
      }

      // Find the downloaded file (may have any audio extension)
      let downloadedFile;
      try {
        const files = fs.readdirSync(jobDir);
        // Find the most recently created file matching the title
        const candidates = files
          .filter(f => f.startsWith(safeTitle) && !f.endsWith('.wav') && !f.endsWith('.part'))
          .map(f => ({ name: f, mtime: fs.statSync(path.join(jobDir, f)).mtimeMs }))
          .sort((a, b) => b.mtime - a.mtime);
        if (candidates.length > 0) downloadedFile = path.join(jobDir, candidates[0].name);
      } catch {}

      // If we couldn't find a non-wav, check if yt-dlp already created a wav
      if (!downloadedFile) {
        if (fs.existsSync(wavPath)) {
          return resolve(wavPath);
        }
        return reject(new Error(`Download failed for "${safeTitle}". ${stderr.slice(0, 200)}`));
      }

      // Convert to WAV using ffmpeg
      emit({ type: 'track_progress', index, percent: 0, stage: 'converting' });

      const ffmpegArgs = [
        '-y',
        '-i', downloadedFile,
        '-acodec', 'pcm_s16le',
        '-ar', '44100',
        '-ac', '2',
        wavPath
      ];

      const ffProc = spawn(FFMPEG_PATH, ffmpegArgs);
      let ffStderr = '';

      ffProc.stderr.on('data', d => {
        const text = d.toString();
        ffStderr += text;
        // Parse ffmpeg time progress (Duration vs time=)
        const totalMatch = ffStderr.match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
        const timeMatch = text.match(/time=\s*(\d+):(\d+):([\d.]+)/);
        if (totalMatch && timeMatch) {
          const toSec = (h, m, s) => +h * 3600 + +m * 60 + parseFloat(s);
          const total = toSec(totalMatch[1], totalMatch[2], totalMatch[3]);
          const current = toSec(timeMatch[1], timeMatch[2], timeMatch[3]);
          const pct = total > 0 ? Math.min(100, (current / total) * 100) : 0;
          emit({ type: 'track_progress', index, percent: pct, stage: 'converting' });
        }
      });

      ffProc.on('error', (err) => {
        try { fs.unlinkSync(downloadedFile); } catch {}
        reject(new Error(`ffmpeg not found. Please install ffmpeg. (${err.message})`));
      });

      ffProc.on('close', (ffCode) => {
        // Clean up the raw download file
        try { fs.unlinkSync(downloadedFile); } catch {}

        if (ffCode !== 0) {
          return reject(new Error(`ffmpeg conversion failed (exit ${ffCode}). ${ffStderr.slice(-200)}`));
        }

        if (!fs.existsSync(wavPath)) {
          return reject(new Error(`WAV file was not created for "${safeTitle}".`));
        }

        emit({ type: 'track_progress', index, percent: 100, stage: 'converting' });
        resolve(wavPath);
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function sanitizeFilename(name) {
  return name
    .replace(/[\/\\?%*:|"<>]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 200);
}

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`\n  🎵  Soundcloud WAV running at http://localhost:${PORT}\n`);
  console.log(`  yt-dlp  : ${YTDLP_PATH}`);
  console.log(`  ffmpeg  : ${FFMPEG_PATH}`);
  console.log(`  tmp dir : ${TMP_DIR}\n`);
});
