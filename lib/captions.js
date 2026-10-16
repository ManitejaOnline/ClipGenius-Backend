const MAX_WORDS_PER_CUE = 4;
const MAX_CUE_SECONDS = 2.5;
const MAX_GAP_SECONDS = 0.6;
const HIGHLIGHT_TAG = "{\\c&H00E5FF&}";

// Bottom-centred white text with a thick outline, raised above the Shorts UI overlay
const ASS_HEADER = `[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,76,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,6,2,2,90,90,460,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

// Flattens YouTube json3 captions into timed words (whole lines for human-made subtitles)
const extractWords = (json3) => {
  const words = [];
  for (const event of json3.events || []) {
    if (!event.segs) continue;
    const eventStart = event.tStartMs / 1000;
    const eventEnd = eventStart + (event.dDurationMs || 0) / 1000;
    for (const seg of event.segs) {
      const text = (seg.utf8 || "").replace(/\s+/g, " ").trim();
      if (text) words.push({ start: eventStart + (seg.tOffsetMs || 0) / 1000, eventEnd, text });
    }
  }
  words.sort((a, b) => a.start - b.start);
  return words.map((word, i) => ({
    start: word.start,
    end: Math.min(word.eventEnd, words[i + 1]?.start ?? word.eventEnd),
    text: word.text,
  }));
};

const buildCues = (words, clipStart, clipDuration) => {
  const clipEnd = clipStart + clipDuration;
  const cues = [];
  let cue = null;

  for (const word of words.filter(w => w.end > clipStart && w.start < clipEnd)) {
    const wordCount = word.text.split(" ").length;
    const startsNewCue = !cue
      || cue.wordCount + wordCount > MAX_WORDS_PER_CUE
      || word.end - cue.start > MAX_CUE_SECONDS
      || word.start - cue.end > MAX_GAP_SECONDS;
    if (startsNewCue) {
      cue = { start: word.start, end: word.end, words: [], wordCount: 0 };
      cues.push(cue);
    }
    cue.words.push(word);
    cue.wordCount += wordCount;
    cue.end = word.end;
  }

  const toClipTime = (time) => Math.min(clipDuration, Math.max(0, time - clipStart));
  return cues.map(c => ({
    start: toClipTime(c.start),
    end: toClipTime(c.end),
    words: c.words.map(w => ({ start: toClipTime(w.start), text: w.text })),
  }));
};

const toAssTime = (seconds) => {
  const totalCs = Math.round(seconds * 100);
  const pad = (n) => String(n).padStart(2, "0");
  const h = Math.floor(totalCs / 360000);
  const m = Math.floor(totalCs / 6000) % 60;
  const s = Math.floor(totalCs / 100) % 60;
  return `${h}:${pad(m)}:${pad(s)}.${pad(totalCs % 100)}`;
};

const escapeAssText = (text) =>
  text.replace(/\\/g, "\\\\").replace(/\{/g, "\\{").replace(/\}/g, "\\}");

const dialogue = (start, end, text) =>
  `Dialogue: 0,${toAssTime(start)},${toAssTime(end)},Default,,0,0,0,,${text}`;

// One line per spoken word: the whole cue stays on screen while the current word turns yellow.
// Human-made subtitles only have line timings, so those cues are shown without highlighting.
const cueToDialogues = (cue) => {
  const texts = cue.words.map(w => escapeAssText(w.text));
  const hasWordTimings = cue.words.every(w => !w.text.includes(" "));
  if (!hasWordTimings) return [dialogue(cue.start, cue.end, texts.join(" "))];

  return cue.words.map((word, i) => {
    const start = i === 0 ? cue.start : word.start;
    const end = i === cue.words.length - 1 ? cue.end : cue.words[i + 1].start;
    const text = texts.map((t, j) => (j === i ? `${HIGHLIGHT_TAG}${t}{\\r}` : t)).join(" ");
    return dialogue(start, end, text);
  });
};

const buildAssSubtitles = (words, clipStart, clipDuration) => {
  const cues = buildCues(words, clipStart, clipDuration).filter(c => c.end > c.start);
  if (cues.length === 0) return null;
  return ASS_HEADER + cues.flatMap(cueToDialogues).join("\n") + "\n";
};

module.exports = { extractWords, buildAssSubtitles };
