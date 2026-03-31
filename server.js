/**
 * Soundcloud WAV – Express backend
 * Downloads YouTube / SoundCloud audio via yt-dlp and converts to WAV with ffmpeg.
 * Progress is streamed to the client via Server-Sent Events (SSE).
 * On completion, all WAVs are compressed into a single ZIP for download.
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
const PORT        = process.env.PORT        || 3000;
const YTDLP_PATH  = process.env.YTDLP_PATH  || 'yt-dlp';
const FFMPEG_PATH = process.env.FFMPEG_PATH  || 'ffmpeg';
const TMP_DIR     = process.env.TMP_DIR     || path.join(os.tmpdir(), 'soundcloud-wav');

// Ensure temp directory exists
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// In-memory job store  { jobId -> { status, files: [], error, zipPath } }
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

  const validHosts = [
    'youtube.com', 'youtu.be', 'soundcloud.com',
    'www.youtube.com', 'www.soundcloud.com', 'm.youtube.com', 'music.youtube.com'
  ];
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
  jobs[jobId] = { status: 'pending', files: [], error: null, zipPath: null };

  res.json({ jobId });

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

  const job = jobs[jobId];
  if (!job._listeners) job._listeners = [];
  job._listeners.push(send);

  if (job._events) {
    for (const ev of job._events) send(ev);
  }

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
// GET /api/zip/:jobId  — serve the ZIP then clean up
// ---------------------------------------------------------------------------
app.get('/api/zip/:jobId', (req, res) => {
  const { jobId } = req.params;
  const job = jobs[jobId];
  if (!job) return res.status(404).send('Job not found.');
  if (!job.zipPath || !fs.existsSync(job.zipPath)) {
    return res.status(404).send('ZIP file not found or already downloaded.');
  }

  const zipName = path.basename(job.zipPath);
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(zipName)}"`);
  res.setHeader('Content-Type', 'application/zip');

  const stream = fs.createReadStream(job.zipPath);
  stream.pipe(res);
  stream.on('end', () => {
    // Delete the ZIP file and the job directory after delivery
    try { fs.rmSync(job.zipPath, { force: true }); } catch {}
    const jobDir = path.join(TMP_DIR, jobId);
    try { fs.rmSync(jobDir, { recursive: true, force: true }); } catch {}
    job.zipPath = null; // mark as consumed
    setTimeout(() => { delete jobs[jobId]; }, 5 * 60 * 1000);
  });
  stream.on('error', (err) => {
    console.error('Stream error:', err);
    res.status(500).end();
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
  // Step 1: Get track list
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
    }
  }

  if (completedFiles.length === 0) {
    job.status = 'done';
    emit({ type: 'done', files: [], zipReady: false });
    return;
  }

  // ------------------------------------------------------------------
  // Step 3: Compress all WAVs into a ZIP
  // ------------------------------------------------------------------
  emit({ type: 'status', message: 'Compressing files into ZIP…' });
  emit({ type: 'zipping' });

  try {
    const zipPath = await createZip(jobDir, jobId);
    job.zipPath = zipPath;
    job.status = 'done';
    emit({ type: 'done', files: completedFiles, zipReady: true });
  } catch (err) {
    job.status = 'done';
    emit({ type: 'done', files: completedFiles, zipReady: false, zipError: err.message });
  }

  // Safety cleanup: if the user never downloads the ZIP, delete everything after 1 hour
  setTimeout(() => {
    if (jobs[jobId]) {
      const jobDir = path.join(TMP_DIR, jobId);
      try { fs.rmSync(jobDir, { recursive: true, force: true }); } catch {}
      if (jobs[jobId].zipPath) {
        try { fs.rmSync(jobs[jobId].zipPath, { force: true }); } catch {}
      }
      delete jobs[jobId];
    }
  }, 60 * 60 * 1000); // 1 hour
}

// ---------------------------------------------------------------------------
// Create ZIP of all WAVs in jobDir using Python3 (cross-platform, no deps)
// ---------------------------------------------------------------------------
function createZip(jobDir, jobId) {
  return new Promise((resolve, reject) => {
    const zipPath = path.join(TMP_DIR, `${jobId}.zip`);

    // Gather all wav files (full paths)
    let wavFiles;
    try {
      wavFiles = fs.readdirSync(jobDir)
        .filter(f => f.endsWith('.wav'))
        .map(f => path.join(jobDir, f));
    } catch (err) {
      return reject(new Error(`Cannot read job directory: ${err.message}`));
    }

    if (wavFiles.length === 0) {
      return reject(new Error('No WAV files found to compress.'));
    }

    // Python one-liner: create a ZIP with all wav files (arcname = basename only)
    const pyScript = [
      'import zipfile, sys, os',
      'zip_path = sys.argv[1]',
      'files = sys.argv[2:]',
      'z = zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED)',
      '[z.write(f, os.path.basename(f)) for f in files]',
      'z.close()'
    ].join('; ');

    const args = ['-c', pyScript, zipPath, ...wavFiles];
    const proc = spawn('python3', args);

    let stderr = '';
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.stdout.on('data', () => {});

    proc.on('error', err => {
      reject(new Error(`python3 not found: ${err.message}`));
    });

    proc.on('close', code => {
      if (code !== 0) {
        return reject(new Error(`Python ZIP failed (exit ${code}): ${stderr.slice(0, 300)}`));
      }
      if (!fs.existsSync(zipPath)) {
        return reject(new Error('ZIP file was not created.'));
      }
      resolve(zipPath);
    });
  });
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
// Uses an isolated subdirectory + %(title)s template so the real platform
// title is always used for the filename, regardless of flat-playlist data.
// ---------------------------------------------------------------------------
function downloadAndConvert(url, hintTitle, jobDir, jobId, index, total, emit) {
  return new Promise((resolve, reject) => {
    // Isolated subdirectory for this track to avoid filename collisions
    const trackDir = path.join(jobDir, `t${index}`);
    fs.mkdirSync(trackDir, { recursive: true });

    const outputTemplate = path.join(trackDir, '%(title)s.%(ext)s');

    const ytdlpArgs = [
      '--no-playlist',
      '--no-warnings',
      '--ignore-errors',
      '-f', 'bestaudio',
      '--output', outputTemplate,
      '--newline',
      '--progress',
      url
    ];

    const proc = spawn(YTDLP_PATH, ytdlpArgs);
    let stderr = '';

    proc.stdout.on('data', (data) => {
      const text = data.toString();
      // Real title from yt-dlp destination line
      const destMatch = text.match(/\[download\] Destination: (.+)/);
      if (destMatch) {
        const basename = path.basename(destMatch[1].trim());
        const realTitle = path.basename(basename, path.extname(basename));
        emit({ type: 'track_title', index, title: realTitle });
      }
      // Download progress
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

    proc.on('close', () => {
      // Find the downloaded audio file in the isolated subdirectory
      let downloadedFile;
      try {
        const files = fs.readdirSync(trackDir)
          .filter(f => !f.endsWith('.part') && !f.endsWith('.ytdl'))
          .map(f => ({ name: f, mtime: fs.statSync(path.join(trackDir, f)).mtimeMs }))
          .sort((a, b) => b.mtime - a.mtime);
        if (files.length > 0) downloadedFile = path.join(trackDir, files[0].name);
      } catch {}

      if (!downloadedFile) {
        // Clean up empty trackDir
        try { fs.rmSync(trackDir, { recursive: true, force: true }); } catch {}
        return reject(new Error(`Download failed for "${hintTitle}". ${stderr.slice(0, 200)}`));
      }

      // Derive clean WAV name from the actual downloaded filename (real title)
      const realBase = path.basename(downloadedFile, path.extname(downloadedFile));
      const safeBase = sanitizeFilename(realBase);
      const wavPath = path.join(jobDir, `${safeBase}.wav`);

      // Convert to WAV
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
        const totalMatch = ffStderr.match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
        const timeMatch = text.match(/time=\s*(\d+):(\d+):([\d.]+)/);
        if (totalMatch && timeMatch) {
          const toSec = (h, m, s) => +h * 3600 + +m * 60 + parseFloat(s);
          const tot = toSec(totalMatch[1], totalMatch[2], totalMatch[3]);
          const current = toSec(timeMatch[1], timeMatch[2], timeMatch[3]);
          const pct = tot > 0 ? Math.min(100, (current / tot) * 100) : 0;
          emit({ type: 'track_progress', index, percent: pct, stage: 'converting' });
        }
      });

      ffProc.on('error', (err) => {
        try { fs.rmSync(trackDir, { recursive: true, force: true }); } catch {}
        reject(new Error(`ffmpeg not found. Please install ffmpeg. (${err.message})`));
      });

      ffProc.on('close', (ffCode) => {
        // Clean up the isolated track subdirectory
        try { fs.rmSync(trackDir, { recursive: true, force: true }); } catch {}

        if (ffCode !== 0) {
          return reject(new Error(`ffmpeg conversion failed (exit ${ffCode}). ${ffStderr.slice(-200)}`));
        }
        if (!fs.existsSync(wavPath)) {
          return reject(new Error(`WAV file was not created for "${hintTitle}".`));
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
