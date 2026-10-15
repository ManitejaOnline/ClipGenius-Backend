const path = require("path");
const { runProcess } = require("./process");

const RENDER_TIMEOUT_MS = 5 * 60 * 1000;
const FADE_SECONDS = 0.5;

const FRAMING_FILTERS = {
  // Fills the 9:16 frame by cutting off the sides of wide videos
  crop: "[0:v]crop=w='min(iw,ih*9/16)':h=ih,scale=1080:1920:force_original_aspect_ratio=decrease,"
    + "pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black,setsar=1",
  // Shows the whole frame over a blurred, zoomed copy of itself (blurred at low resolution for speed)
  blur: "[0:v]split=2[bg][fg];"
    + "[bg]scale=270:480:force_original_aspect_ratio=increase,crop=270:480,boxblur=10:2,scale=1080:1920,setsar=1[bgblur];"
    + "[fg]scale=1080:1920:force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1[fgfit];"
    + "[bgblur][fgfit]overlay=(W-w)/2:(H-h)/2",
};
const FRAMINGS = Object.keys(FRAMING_FILTERS);

const ffmpegInputArgs = (source, startTime) => {
  const headers = Object.entries(source.http_headers || {})
    .map(([name, value]) => `${name}: ${value}\r\n`)
    .join("");
  return ["-ss", String(startTime), ...(headers ? ["-headers", headers] : []), "-i", source.url];
};

// Reads only the needed range straight from YouTube's servers and outputs a 1080x1920 clip
const renderClip = async ({ sources, startTime, duration, framing, outputPath, subtitlesPath }) => {
  const fadeOutStart = Math.max(0, duration - FADE_SECONDS);
  const separateAudio = sources.audio && sources.audio !== sources.video;

  const videoFilters = [
    FRAMING_FILTERS[framing],
    `fade=t=in:st=0:d=${FADE_SECONDS}`,
    `fade=t=out:st=${fadeOutStart}:d=${FADE_SECONDS}`,
  ];
  // The subtitles filter can't parse Windows drive letters, so ffmpeg runs from the file's folder
  if (subtitlesPath) videoFilters.push(`subtitles=${path.basename(subtitlesPath)}`);

  const args = [
    "-hide_banner", "-loglevel", "error", "-y",
    ...ffmpegInputArgs(sources.video, startTime),
    ...(separateAudio ? ffmpegInputArgs(sources.audio, startTime) : []),
    "-t", String(duration),
    "-filter_complex", `${videoFilters.join(",")}[v]`,
    "-map", "[v]",
    "-map", separateAudio ? "1:a:0" : "0:a:0?",
    "-af", `afade=t=in:st=0:d=${FADE_SECONDS},afade=t=out:st=${fadeOutStart}:d=${FADE_SECONDS}`,
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "192k",
    "-movflags", "+faststart",
    path.basename(outputPath),
  ];

  try {
    await runProcess("ffmpeg", args, {
      cwd: path.dirname(outputPath),
      timeoutMs: RENDER_TIMEOUT_MS,
      timeoutMessage: "Timed out cutting a clip. Please try again.",
    });
  } catch (err) {
    if (err.stderr === undefined) throw err;
    console.error("ffmpeg failed:", err.stderr);
    throw new Error("Couldn't cut a clip from this video. Please try again.");
  }
};

module.exports = { FRAMINGS, ffmpegInputArgs, renderClip };
