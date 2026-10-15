const fs = require("fs");
const path = require("path");
const { runProcess } = require("./process");

const YTDLP_PATH = path.join(__dirname, "..", "yt-dlp.exe");
const FORMAT = "bestvideo[ext=mp4][height<=1080]+bestaudio[ext=m4a]/best[ext=mp4]/best";
const YTDLP_TIMEOUT_MS = 2 * 60 * 1000;
const INFO_TTL_MS = 60 * 60 * 1000;

const UPDATE_TIMEOUT_MS = 2 * 60 * 1000;
const YOUTUBE_HOSTS = ["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "www.youtube-nocookie.com"];

const infoCache = new Map();

// Accepts watch, youtu.be, Shorts, live and embed links
const extractVideoId = (url) => {
  try {
    const parsed = new URL(String(url).trim());
    let id = null;
    if (parsed.hostname === "youtu.be") {
      id = parsed.pathname.split("/")[1];
    } else if (YOUTUBE_HOSTS.includes(parsed.hostname)) {
      id = parsed.searchParams.get("v") || parsed.pathname.match(/^\/(?:shorts|live|embed)\/([\w-]{11})/)?.[1];
    }
    return /^[\w-]{11}$/.test(id) ? id : null;
  } catch {
    return null;
  }
};

// YouTube changes often enough to break old yt-dlp builds, so keep it current
const updateYtDlp = async () => {
  try {
    const output = await runProcess(YTDLP_PATH, ["-U"], { timeoutMs: UPDATE_TIMEOUT_MS });
    console.log(`yt-dlp: ${output.trim().split(/\r?\n/).pop()}`);
  } catch (err) {
    console.error("yt-dlp update failed:", err.stderr || err.message);
  }
};

const describeYtDlpError = (stderr = "") => {
  const errorLine = stderr.split(/\r?\n/).reverse().find(line => line.startsWith("ERROR:"));
  if (!errorLine) return "Could not read this video from YouTube";
  return errorLine.replace(/^ERROR:\s*(\[[^\]]+\]\s*)?([\w-]{11}:\s*)?/, "");
};

const runYtDlp = async (args) => {
  try {
    return await runProcess(YTDLP_PATH, ["--js-runtimes", "node", "--socket-timeout", "30", ...args], {
      timeoutMs: YTDLP_TIMEOUT_MS,
      timeoutMessage: "Timed out talking to YouTube. Please try again.",
    });
  } catch (err) {
    throw err.stderr !== undefined ? new Error(describeYtDlpError(err.stderr)) : err;
  }
};

const getVideoInfo = (videoId) => {
  const now = Date.now();
  for (const [id, entry] of infoCache) {
    if (now - entry.fetchedAt > INFO_TTL_MS) infoCache.delete(id);
  }

  const cached = infoCache.get(videoId);
  if (cached) return cached.promise;

  const promise = runYtDlp(["-j", "--no-playlist", "-f", FORMAT, `https://www.youtube.com/watch?v=${videoId}`])
    .then(JSON.parse);
  infoCache.set(videoId, { promise, fetchedAt: now });
  promise.catch(() => infoCache.delete(videoId));
  return promise;
};

const getStreamSources = (info) => {
  const formats = info.requested_formats || [info];
  return {
    video: formats.find(f => f.vcodec && f.vcodec !== "none"),
    audio: formats.find(f => f.acodec && f.acodec !== "none"),
  };
};

// Prefers human-made subtitles, then YouTube's auto-captions in the video's spoken language
const pickCaptionTrack = (info) => {
  const subtitles = info.subtitles || {};
  const autoCaptions = info.automatic_captions || {};
  const originalAutoLang = Object.keys(autoCaptions).find(lang => lang.endsWith("-orig"));
  const language = info.language || originalAutoLang?.replace(/-orig$/, "") || "en";

  const manualLang = Object.keys(subtitles).find(lang => lang === language || lang.startsWith(`${language}-`));
  if (manualLang) return { lang: manualLang, auto: false };
  if (autoCaptions[`${language}-orig`]) return { lang: `${language}-orig`, auto: true };
  if (autoCaptions[language]) return { lang: language, auto: true };
  return null;
};

const downloadCaptions = async (info, track, outputBase) => {
  const infoPath = `${outputBase}.info.json`;
  const captionsPath = `${outputBase}.${track.lang}.json3`;
  await fs.promises.writeFile(infoPath, JSON.stringify(info));
  try {
    await runYtDlp([
      "--load-info-json", infoPath,
      "--skip-download",
      track.auto ? "--write-auto-subs" : "--write-subs",
      "--sub-langs", track.lang,
      "--sub-format", "json3",
      "-o", outputBase,
    ]);
    return JSON.parse(await fs.promises.readFile(captionsPath, "utf8"));
  } finally {
    fs.unlink(infoPath, () => {});
    fs.unlink(captionsPath, () => {});
  }
};

module.exports = {
  extractVideoId,
  updateYtDlp,
  getVideoInfo,
  getStreamSources,
  pickCaptionTrack,
  downloadCaptions,
};
