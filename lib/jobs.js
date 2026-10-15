const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { getVideoInfo, getStreamSources, pickCaptionTrack, downloadCaptions } = require("./youtube");
const { findHighlights, clampWindow, snapToPauses } = require("./highlights");
const { extractWords, buildAssSubtitles } = require("./captions");
const { renderClip } = require("./render");
const { createQueue } = require("./queue");

const VIDEO_DIR = path.join(__dirname, "..", "videos");
const CLIP_COUNT = 3;
const MAX_CLIPS_PER_JOB = 10;

const jobs = new Map();
const enqueue = createQueue();

const setStep = (job, step, progress) => Object.assign(job, { step, progress });

const toPublicJob = ({ createdAt, context, clipCounter, ...publicJob }) => publicJob;

const clipFilePath = (preview) => path.join(VIDEO_DIR, path.basename(preview.outputPath));

// Captions are fetched even when not burned in, because their timings are used to cut at pauses
const loadCaptionWords = async (info, outputBase) => {
  const track = pickCaptionTrack(info);
  if (!track) return { words: null, note: "This video has no captions, so clips are uncaptioned." };
  try {
    return { words: extractWords(await downloadCaptions(info, track, outputBase)), note: null };
  } catch (err) {
    console.error("Caption download failed:", err.message);
    return { words: null, note: "Couldn't load captions for this video, so clips are uncaptioned." };
  }
};

const prepareWindow = ({ words, videoDuration }, window) =>
  words && window.duration < videoDuration ? snapToPauses(words, window, videoDuration) : window;

const cutClip = async (job, window) => {
  const { sources, words, captions, framing, baseUrl } = job.context;
  job.clipCounter += 1;
  const fileBase = path.join(VIDEO_DIR, `${job.id}-clip-${job.clipCounter}`);
  const subtitles = captions && words && buildAssSubtitles(words, window.startTime, window.duration);
  const subtitlesPath = subtitles && `${fileBase}.ass`;
  if (subtitlesPath) await fs.promises.writeFile(subtitlesPath, subtitles);

  try {
    await renderClip({ sources, ...window, framing, outputPath: `${fileBase}.mp4`, subtitlesPath });
  } finally {
    if (subtitlesPath) fs.unlink(subtitlesPath, () => {});
  }

  return {
    outputPath: `${baseUrl}/videos/${path.basename(fileBase)}.mp4`,
    startTime: window.startTime,
    duration: window.duration,
    hasCaptions: Boolean(subtitles),
  };
};

const generateClips = async (job, { clipDuration, captions, framing, baseUrl }) => {
  setStep(job, "Fetching video info", 0.05);
  const info = await getVideoInfo(job.videoId);
  if (info.is_live) throw new Error("Live streams can't be clipped. Try again after the stream ends.");
  const sources = getStreamSources(info);

  setStep(job, "Finding the best moments", 0.15);
  const { method, graph, windows } = await findHighlights(info, sources.audio, clipDuration, CLIP_COUNT);

  setStep(job, "Fetching captions", 0.3);
  const { words, note } = await loadCaptionWords(info, path.join(VIDEO_DIR, job.id));

  Object.assign(job, { method, graph, videoDuration: info.duration, note: captions ? note : null });
  job.context = { sources, words, captions, framing, clipDuration, videoDuration: info.duration, baseUrl };

  let finished = 0;
  setStep(job, `Cutting clips (0 of ${windows.length} done)`, 0.4);
  job.previews = await Promise.all(windows.map(async (window) => {
    const preview = await cutClip(job, prepareWindow(job.context, window));
    finished += 1;
    setStep(job, `Cutting clips (${finished} of ${windows.length} done)`, 0.4 + 0.6 * (finished / windows.length));
    return preview;
  }));
};

const runQueued = (job, task) => {
  Object.assign(job, { status: "running", error: null });
  enqueue(task, (ahead) => setStep(job, `Waiting for ${ahead} other ${ahead === 1 ? "job" : "jobs"} to finish`, 0))
    .then(() => {
      job.status = "done";
      setStep(job, "Done", 1);
    })
    .catch((err) => {
      console.error(`Job ${job.id} failed:`, err.message);
      Object.assign(job, { status: "error", error: err.message });
    });
};

const createJob = ({ videoId, clipDuration, captions, framing, baseUrl }) => {
  const job = {
    id: `${videoId}-${crypto.randomBytes(4).toString("hex")}`,
    videoId,
    createdAt: Date.now(),
    status: "running",
    step: "Starting",
    progress: 0,
    method: null,
    note: null,
    graph: null,
    videoDuration: null,
    previews: null,
    error: null,
    clipCounter: 0,
    context: null,
  };
  jobs.set(job.id, job);
  runQueued(job, () => generateClips(job, { clipDuration, captions, framing, baseUrl }));
  return job;
};

const addClip = (job, startTime) => {
  if (job.previews.length >= MAX_CLIPS_PER_JOB) {
    throw new Error(`You can have up to ${MAX_CLIPS_PER_JOB} clips per video`);
  }
  const { clipDuration, videoDuration } = job.context;
  const window = prepareWindow(job.context, clampWindow(startTime, clipDuration, videoDuration));

  runQueued(job, async () => {
    setStep(job, "Cutting clip", 0.3);
    const preview = await cutClip(job, window);
    job.previews = [...job.previews, preview];
  });
};

const getJob = (id) => jobs.get(id);

const removeStaleJobs = (maxAgeMs) => {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (now - job.createdAt > maxAgeMs) jobs.delete(id);
  }
};

module.exports = {
  VIDEO_DIR,
  createJob,
  addClip,
  getJob,
  removeStaleJobs,
  toPublicJob,
  clipFilePath,
};
