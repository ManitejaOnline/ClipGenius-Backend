const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const { ZipArchive } = require("archiver");
const { extractVideoId, getVideoInfo, pickCaptionTrack, updateYtDlp } = require("./lib/youtube");
const { FRAMINGS } = require("./lib/render");
const {
  VIDEO_DIR,
  createJob,
  addClip,
  getJob,
  removeStaleJobs,
  toPublicJob,
  clipFilePath,
} = require("./lib/jobs");

const app = express();
app.use(cors());
app.use(express.json());

if (!fs.existsSync(VIDEO_DIR)) fs.mkdirSync(VIDEO_DIR);

const PORT = process.env.PORT || 5000;
const CLIP_DURATIONS = [15, 30, 60];
const DEFAULT_CLIP_DURATION = 30;
const DEFAULT_FRAMING = "crop";
const FILE_TTL_MS = 60 * 60 * 1000;
const YTDLP_UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1000;

app.get("/videos/:file", (req, res, next) => {
  if (!("download" in req.query)) return next();
  res.download(path.join(VIDEO_DIR, path.basename(req.params.file)), (err) => {
    if (err && !res.headersSent) res.status(404).end();
  });
});
app.use("/videos", express.static(VIDEO_DIR));

const removeStaleFiles = () => {
  const now = Date.now();
  for (const name of fs.readdirSync(VIDEO_DIR)) {
    const filePath = path.join(VIDEO_DIR, name);
    if (now - fs.statSync(filePath).mtimeMs > FILE_TTL_MS) fs.unlink(filePath, () => {});
  }
  removeStaleJobs(FILE_TTL_MS);
};

const formatTimeForFileName = (totalSeconds) => {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = String(Math.floor(totalSeconds % 60)).padStart(2, "0");
  return `${minutes}m${seconds}s`;
};

// GET /api/video-info?url=... - Title, length and clip options for the preview card
app.get("/api/video-info", async (req, res) => {
  const videoId = extractVideoId(req.query.url);
  if (!videoId) return res.status(400).json({ success: false, error: "Invalid YouTube URL" });

  try {
    const info = await getVideoInfo(videoId);
    res.json({
      success: true,
      data: {
        videoId,
        title: info.title,
        channel: info.channel || info.uploader,
        duration: info.duration,
        thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
        isLive: Boolean(info.is_live),
        hasMostReplayed: Array.isArray(info.heatmap) && info.heatmap.length > 0,
        hasCaptions: Boolean(pickCaptionTrack(info)),
      },
    });
  } catch (err) {
    res.status(502).json({ success: false, error: err.message });
  }
});

// POST /api/jobs - Queues highlight clip generation; poll GET /api/jobs/:id for progress
app.post("/api/jobs", (req, res) => {
  const { url, clipDuration = DEFAULT_CLIP_DURATION, captions = true, framing = DEFAULT_FRAMING } = req.body;

  const videoId = extractVideoId(url);
  if (!videoId) return res.status(400).json({ success: false, error: "Invalid YouTube URL" });
  if (!CLIP_DURATIONS.includes(clipDuration)) {
    return res.status(400).json({ success: false, error: `Clip length must be one of ${CLIP_DURATIONS.join(", ")} seconds` });
  }
  if (!FRAMINGS.includes(framing)) {
    return res.status(400).json({ success: false, error: `Framing must be one of ${FRAMINGS.join(", ")}` });
  }

  removeStaleFiles();

  const job = createJob({
    videoId,
    clipDuration,
    captions: Boolean(captions),
    framing,
    baseUrl: `${req.protocol}://${req.get("host")}`,
  });
  res.status(202).json({ success: true, data: { jobId: job.id } });
});

app.get("/api/jobs/:id", (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ success: false, error: "Job not found" });
  res.json({ success: true, data: toPublicJob(job) });
});

// POST /api/jobs/:id/clips - { startTime } adds a clip starting near startTime
app.post("/api/jobs/:id/clips", (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ success: false, error: "Job not found" });
  if (job.status === "running" || !job.previews) {
    return res.status(409).json({ success: false, error: "Please wait until the current clips are ready" });
  }

  const { startTime } = req.body;
  if (typeof startTime !== "number" || !Number.isFinite(startTime)) {
    return res.status(400).json({ success: false, error: "startTime must be a number of seconds" });
  }

  try {
    addClip(job, startTime);
    res.status(202).json({ success: true, data: { jobId: job.id } });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// GET /api/jobs/:id/zip - All clips of a job in one download
app.get("/api/jobs/:id/zip", (req, res) => {
  const job = getJob(req.params.id);
  if (!job?.previews?.length) return res.status(404).json({ success: false, error: "No clips to download" });

  res.attachment(`${job.videoId}-clips.zip`);
  const archive = new ZipArchive({ store: true });
  archive.on("error", (err) => {
    console.error("Zip failed:", err.message);
    res.destroy(err);
  });
  archive.pipe(res);
  job.previews.forEach((preview, index) => {
    archive.append(fs.createReadStream(clipFilePath(preview)), {
      name: `clip-${index + 1}-at-${formatTimeForFileName(preview.startTime)}.mp4`,
    });
  });
  archive.finalize();
});

app.listen(PORT, () => {
  console.log(`🚀 Backend running at http://localhost:${PORT}`);
});

updateYtDlp();
setInterval(updateYtDlp, YTDLP_UPDATE_INTERVAL_MS).unref();
