const { runProcess } = require("./process");
const { ffmpegInputArgs } = require("./render");

// Viewers replay the first seconds of most videos, so the intro would always win otherwise
const INTRO_SKIP_RATIO = 0.05;
const AUDIO_ANALYSIS_MAX_SECONDS = 30 * 60;
const AUDIO_ANALYSIS_TIMEOUT_MS = 3 * 60 * 1000;
const GRAPH_POINTS = 200;

const MIN_PAUSE_SECONDS = 0.7;
const SNAP_MAX_EARLIER = 3;
const SNAP_MAX_LATER = 2;
const SNAP_LEAD_IN = 0.15;
const SNAP_LAST_WORD = 0.8;

const scoreWindow = (segments, start, end) => {
  let total = 0;
  for (const seg of segments) {
    const overlap = Math.min(seg.end, end) - Math.max(seg.start, start);
    if (overlap > 0) total += overlap * seg.value;
  }
  return total / (end - start);
};

const pickTopWindows = (segments, videoDuration, clipDuration, count) => {
  const latestStart = videoDuration - clipDuration;
  const earliestStart = Math.min(videoDuration * INTRO_SKIP_RATIO, latestStart);
  const step = Math.max(1, clipDuration / 10);

  const candidates = [];
  for (let start = earliestStart; start <= latestStart; start += step) {
    candidates.push({ start, score: scoreWindow(segments, start, start + clipDuration) });
  }
  for (const candidate of candidates) {
    candidate.isPeak = candidates.every(other =>
      Math.abs(other.start - candidate.start) > clipDuration / 2 || other.score <= candidate.score);
  }
  candidates.sort((a, b) => b.score - a.score);

  // First pass takes separate peaks; the second fills up with any non-overlapping windows
  const passes = [
    { minDistance: clipDuration * 2, peaksOnly: true },
    { minDistance: clipDuration, peaksOnly: false },
  ];
  const chosen = [];
  for (const { minDistance, peaksOnly } of passes) {
    for (const candidate of candidates) {
      if (chosen.length === count) break;
      if (peaksOnly && !candidate.isPeak) continue;
      if (chosen.every(c => Math.abs(c.start - candidate.start) >= minDistance)) chosen.push(candidate);
    }
  }
  return chosen.map(c => ({ startTime: Math.round(c.start * 10) / 10, duration: clipDuration }));
};

const evenlySpacedWindows = (videoDuration, clipDuration, count) =>
  Array.from({ length: count }, (_, i) => ({
    startTime: Math.round(((i + 1) / (count + 1)) * (videoDuration - clipDuration) * 10) / 10,
    duration: clipDuration,
  }));

// Returns one RMS loudness reading per second of audio, normalised to 0..1
const measureLoudness = async (audioSource, videoDuration) => {
  const readings = [];
  let currentTime = 0;

  await runProcess("ffmpeg", [
    "-hide_banner", "-loglevel", "error",
    ...ffmpegInputArgs(audioSource, 0),
    "-t", String(Math.min(videoDuration, AUDIO_ANALYSIS_MAX_SECONDS)),
    "-vn",
    "-af", "aresample=8000,asetnsamples=n=8000:p=0,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-",
    "-f", "null", "-",
  ], {
    timeoutMs: AUDIO_ANALYSIS_TIMEOUT_MS,
    timeoutMessage: "Audio analysis timed out",
    onStdoutLine: (line) => {
      const time = line.match(/pts_time:([\d.]+)/);
      if (time) currentTime = parseFloat(time[1]);
      const level = line.match(/RMS_level=(-?[\d.]+|-inf)/);
      if (level) readings.push({ start: currentTime, end: currentTime + 1, db: parseFloat(level[1]) });
    },
  });

  const finite = readings.filter(r => Number.isFinite(r.db)).map(r => r.db);
  const min = Math.min(...finite);
  const range = Math.max(...finite) - min || 1;
  return readings.map(r => ({
    start: r.start,
    end: r.end,
    value: Number.isFinite(r.db) ? (r.db - min) / range : 0,
  }));
};

// Averages segments into at most maxPoints buckets so the UI graph stays small
const downsample = (segments, maxPoints) => {
  const size = Math.ceil(segments.length / maxPoints);
  const points = [];
  for (let i = 0; i < segments.length; i += size) {
    const bucket = segments.slice(i, i + size);
    points.push({
      start: bucket[0].start,
      end: bucket[bucket.length - 1].end,
      value: Math.round((bucket.reduce((sum, s) => sum + s.value, 0) / bucket.length) * 1000) / 1000,
    });
  }
  return points;
};

const findHighlights = async (info, audioSource, clipDuration, count) => {
  const videoDuration = info.duration;
  if (videoDuration <= clipDuration) {
    return { method: "whole-video", graph: null, windows: [{ startTime: 0, duration: videoDuration }] };
  }

  if (Array.isArray(info.heatmap) && info.heatmap.length > 0) {
    const segments = info.heatmap.map(h => ({ start: h.start_time, end: h.end_time, value: h.value }));
    return {
      method: "most-replayed",
      graph: downsample(segments, GRAPH_POINTS),
      windows: pickTopWindows(segments, videoDuration, clipDuration, count),
    };
  }

  try {
    const segments = await measureLoudness(audioSource, videoDuration);
    const analysedDuration = Math.min(videoDuration, AUDIO_ANALYSIS_MAX_SECONDS);
    if (segments.length > clipDuration) {
      return {
        method: "loudest",
        graph: downsample(segments, GRAPH_POINTS),
        windows: pickTopWindows(segments, analysedDuration, clipDuration, count),
      };
    }
  } catch (err) {
    console.error("Audio analysis failed, using evenly spaced clips:", err.message);
  }
  return { method: "evenly-spaced", graph: null, windows: evenlySpacedWindows(videoDuration, clipDuration, count) };
};

const clampWindow = (startTime, clipDuration, videoDuration) => {
  const duration = Math.min(clipDuration, videoDuration);
  return {
    startTime: Math.round(Math.min(Math.max(0, startTime), videoDuration - duration) * 10) / 10,
    duration,
  };
};

// Moves clip edges by up to a few seconds so they land in gaps between spoken words.
// Caption timings only mark when each word starts, so a long gap between starts is treated as a pause.
const snapToPauses = (words, { startTime, duration }, videoDuration) => {
  const pauses = [];
  for (let i = 0; i < words.length - 1; i++) {
    const gap = words[i + 1].start - words[i].start;
    if (gap >= MIN_PAUSE_SECONDS) {
      pauses.push({
        lastWordStart: words[i].start,
        nextWordStart: words[i + 1].start,
        gap,
        endsSentence: /[.?!।]["')\]]?$/.test(words[i].text),
      });
    }
  }

  const bestPauseTime = (target, timeAtPause) => {
    let best = null;
    let bestScore = -Infinity;
    for (const pause of pauses) {
      const time = timeAtPause(pause);
      const shift = time - target;
      if (shift < -SNAP_MAX_EARLIER || shift > SNAP_MAX_LATER) continue;
      const score = Math.min(pause.gap, 3) + (pause.endsSentence ? 1 : 0) - 0.3 * Math.abs(shift);
      if (score > bestScore) {
        bestScore = score;
        best = time;
      }
    }
    return best;
  };

  const start = bestPauseTime(startTime, p => p.nextWordStart - SNAP_LEAD_IN) ?? startTime;
  const end = bestPauseTime(startTime + duration, p => Math.min(p.nextWordStart - 0.1, p.lastWordStart + SNAP_LAST_WORD)) ?? startTime + duration;
  const snappedStart = Math.max(0, start);
  const snappedEnd = Math.min(videoDuration, Math.max(end, snappedStart + 1));
  return {
    startTime: Math.round(snappedStart * 10) / 10,
    duration: Math.round((snappedEnd - snappedStart) * 10) / 10,
  };
};

module.exports = { findHighlights, clampWindow, snapToPauses };
