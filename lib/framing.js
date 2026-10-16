const path = require("path");
const ort = require("onnxruntime-node");
const { runProcess } = require("./process");
const { ffmpegInputArgs } = require("./render");

// UltraFace RFB-320 (MIT licence): input 1x3x240x320 RGB, outputs per-anchor scores and corner boxes in 0-1 units
const MODEL_PATH = path.join(__dirname, "..", "models", "ultraface-rfb-320.onnx");
const FRAME_W = 320;
const FRAME_H = 240;
const FRAME_BYTES = FRAME_W * FRAME_H * 3;

const SAMPLE_FPS = 2;
const ANALYSIS_TIMEOUT_MS = 2 * 60 * 1000;
const MIN_BAR_RATIO = 0.02;
// A dark clip can look like one big black bar, so never trust a crop that removes most of the picture
const MIN_KEPT_RATIO = 0.5;
const FACE_SCORE = 0.7;
const MIN_FACE_COVERAGE = 0.3;
const SMOOTH_RADIUS = 3;
const KEYFRAME_EVERY = 2;
const MIN_PAN_PIXELS = 4;

let sessionPromise = null;
const getSession = () => {
  sessionPromise ??= ort.InferenceSession.create(MODEL_PATH, { logSeverityLevel: 3 });
  return sessionPromise;
};

// cropdetect with reset=0 prints the area that was non-black in any frame so far; the last line covers the whole clip
const parseBars = (stderr, width, height) => {
  const matches = [...stderr.matchAll(/crop=(\d+):(\d+):(\d+):(\d+)/g)];
  if (!matches.length) return null;
  const [w, h, x, y] = matches[matches.length - 1].slice(1).map(Number);
  const trimsEnough = (width - w) / width >= MIN_BAR_RATIO || (height - h) / height >= MIN_BAR_RATIO;
  const keepsEnough = w >= width * MIN_KEPT_RATIO && h >= height * MIN_KEPT_RATIO;
  return trimsEnough && keepsEnough ? { w, h, x, y } : null;
};

// Returns the horizontal centre (0-1 of the analysis frame) of the largest confident face, or null
const findFaceCentre = async (session, frame) => {
  const plane = FRAME_W * FRAME_H;
  const input = new Float32Array(plane * 3);
  for (let i = 0; i < plane; i++) {
    input[i] = (frame[i * 3] - 127) / 128;
    input[plane + i] = (frame[i * 3 + 1] - 127) / 128;
    input[plane * 2 + i] = (frame[i * 3 + 2] - 127) / 128;
  }
  const { scores, boxes } = await session.run({ input: new ort.Tensor("float32", input, [1, 3, FRAME_H, FRAME_W]) });

  let best = null;
  for (let i = 0; i < scores.dims[1]; i++) {
    if (scores.data[i * 2 + 1] < FACE_SCORE) continue;
    const [x1, y1, x2, y2] = boxes.data.slice(i * 4, i * 4 + 4);
    const area = (x2 - x1) * (y2 - y1);
    if (!best || area > best.area) best = { centre: (x1 + x2) / 2, area };
  }
  return best && best.centre;
};

const fillGaps = (values) => {
  const firstKnown = values.find(v => v !== null);
  let last = firstKnown;
  return values.map((v) => {
    if (v !== null) last = v;
    return last;
  });
};

const smooth = (values) => values.map((_, i) => {
  const window = values.slice(Math.max(0, i - SMOOTH_RADIUS), i + SMOOTH_RADIUS + 1);
  return window.reduce((sum, v) => sum + v, 0) / window.length;
});

// Piecewise-linear crop x over time, as an ffmpeg expression in t (seconds from the clip start)
const panExpression = (positions) => {
  const keys = positions
    .map((x, i) => ({ t: i / SAMPLE_FPS, x: Math.round(x * 10) / 10 }))
    .filter((_, i) => i % KEYFRAME_EVERY === 0 || i === positions.length - 1);
  const xs = keys.map(k => k.x);
  if (Math.max(...xs) - Math.min(...xs) < MIN_PAN_PIXELS) return String(Math.round(xs[0]));

  let expression = String(keys[keys.length - 1].x);
  for (let k = keys.length - 2; k >= 0; k--) {
    const a = keys[k];
    const b = keys[k + 1];
    const slope = Math.round(((b.x - a.x) / (b.t - a.t)) * 100) / 100;
    expression = `if(lt(t,${b.t}),${a.x}+(${slope})*(t-${a.t}),${expression})`;
  }
  return expression;
};

// Works out black bars to trim and, when following faces, how the 9:16 crop should pan.
// Failures only cost the improvement, never the clip, so they resolve to {}.
const analyzeClip = async ({ sources, startTime, duration, followFaces }) => {
  const { width, height } = sources.video;
  if (!width || !height) return {};
  const detectFaces = followFaces && width / height > 9 / 16;

  const filters = [`fps=${SAMPLE_FPS}`, "cropdetect=limit=24:round=2:reset=0"];
  if (detectFaces) {
    filters.push(
      `scale=${FRAME_W}:${FRAME_H}:force_original_aspect_ratio=decrease`,
      `pad=${FRAME_W}:${FRAME_H}:(ow-iw)/2:(oh-ih)/2`,
      "format=rgb24",
    );
  }

  try {
    const { stdout, stderr } = await runProcess("ffmpeg", [
      "-hide_banner", "-nostats", "-loglevel", "info",
      ...ffmpegInputArgs(sources.video, startTime),
      "-t", String(duration),
      "-an", "-vf", filters.join(","),
      ...(detectFaces ? ["-f", "rawvideo", "pipe:1"] : ["-f", "null", "-"]),
    ], { binary: true, timeoutMs: ANALYSIS_TIMEOUT_MS, timeoutMessage: "Timed out analysing a clip" });

    const bars = parseBars(stderr, width, height);
    if (!detectFaces) return { bars };

    const session = await getSession();
    const centres = [];
    for (let offset = 0; offset + FRAME_BYTES <= stdout.length; offset += FRAME_BYTES) {
      centres.push(await findFaceCentre(session, stdout.subarray(offset, offset + FRAME_BYTES)));
    }
    if (centres.filter(c => c !== null).length < centres.length * MIN_FACE_COVERAGE) return { bars };

    // Map face centres from the letterboxed analysis frame back to source pixels, then into the bar-trimmed frame
    const scale = Math.min(FRAME_W / width, FRAME_H / height);
    const padX = (FRAME_W - width * scale) / 2;
    const frame = bars || { w: width, h: height, x: 0, y: 0 };
    const cropWidth = Math.min(frame.w, (frame.h * 9) / 16);
    const maxX = frame.w - cropWidth;
    const positions = smooth(fillGaps(centres.map(c => (c === null ? null : (c * FRAME_W - padX) / scale - frame.x))))
      .map(centre => Math.min(Math.max(centre - cropWidth / 2, 0), maxX));

    return { bars, panX: panExpression(positions) };
  } catch (err) {
    console.error("Clip analysis failed, using default framing:", err.stderr?.slice(-500) || err.message);
    return {};
  }
};

module.exports = { analyzeClip };
