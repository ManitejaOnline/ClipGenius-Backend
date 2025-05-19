const express = require("express");
const cors = require("cors");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const ffmpeg = require("fluent-ffmpeg");

const app = express();
app.use(cors());
app.use(express.json());

const VIDEO_DIR = path.join(__dirname, "videos");
if (!fs.existsSync(VIDEO_DIR)) fs.mkdirSync(VIDEO_DIR);

const YTDLP_PATH = path.join(__dirname, "yt-dlp.exe");

// Helper function to get video metadata
const getVideoMetadata = (filePath) => {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) reject(err);
      resolve(metadata);
    });
  });
};

// Helper function to detect speech segments
const detectSpeechSegments = (filePath) => {
  return new Promise((resolve, reject) => {
    const tempFile = path.join(VIDEO_DIR, `${path.basename(filePath, '.mp4')}-audio.wav`);
    
    // Extract audio for speech analysis
    ffmpeg(filePath)
      .outputOptions([
        '-ac 1',               // Convert to mono
        '-ar 16000',          // 16kHz sample rate
        '-acodec pcm_s16le'   // PCM format
      ])
      .output(tempFile)
      .on('end', async () => {
        try {
          // Analyze audio for speech segments using volume and frequency analysis
          const segments = [];
          let currentSegment = null;
          
          ffmpeg(tempFile)
            .audioFilters([
              'silencedetect=noise=-30dB:d=0.5', // Detect silence/speech
              'astats=metadata=1:reset=1',        // Detailed audio stats
              'loudnorm=I=-16:TP=-1.5:LRA=11'    // Normalize audio
            ])
            .outputOptions(['-f', 'null'])
            .output('/dev/null')
            .on('stderr', line => {
              // Parse silence detection output
              const silenceStart = line.match(/silence_start: ([\d.]+)/);
              const silenceEnd = line.match(/silence_end: ([\d.]+)/);
              
              if (silenceStart) {
                if (currentSegment) {
                  currentSegment.end = parseFloat(silenceStart[1]);
                  segments.push(currentSegment);
                  currentSegment = null;
                }
              } else if (silenceEnd) {
                currentSegment = {
                  start: parseFloat(silenceEnd[1]),
                  type: 'speech'
                };
              }
            })
            .on('error', reject)
            .on('end', () => {
              fs.unlink(tempFile, () => {});
              resolve(segments);
            })
            .run();
        } catch (err) {
          fs.unlink(tempFile, () => {});
          reject(err);
        }
      })
      .on('error', reject)
      .run();
  });
};

// Helper function to detect scene changes
const detectSceneChanges = (filePath) => {
  return new Promise((resolve, reject) => {
    const scenes = [];
    
    ffmpeg(filePath)
      .outputOptions([
        '-filter:v', 'select=\'gt(scene,0.3)\'', // Detect significant scene changes
        '-an',                                    // Disable audio
        '-f', 'null'                             // No output file needed
      ])
      .output('/dev/null')
      .on('stderr', line => {
        // Parse scene change timestamps
        const sceneMatch = line.match(/scene:(\d+\.\d+)/);
        if (sceneMatch) {
          scenes.push(parseFloat(sceneMatch[1]));
        }
      })
      .on('error', reject)
      .on('end', () => resolve(scenes))
      .run();
  });
};

// Helper function to analyze motion intensity
const analyzeMotion = (filePath) => {
  return new Promise((resolve, reject) => {
    const motionData = [];
    
    ffmpeg(filePath)
      .outputOptions([
        '-filter:v', 'mestimate=method=esa:mb_size=16:search_parameter=7',
        '-f', 'null'
      ])
      .output('/dev/null')
      .on('stderr', line => {
        // Parse motion vectors
        const motionMatch = line.match(/motion_est=([\d.]+)/);
        if (motionMatch) {
          motionData.push(parseFloat(motionMatch[1]));
        }
      })
      .on('error', reject)
      .on('end', () => resolve(motionData))
      .run();
  });
};

// Enhanced audio segment analysis
const analyzeAudioSegments = async (filePath, segmentDuration = 1) => {
  const segments = [];
  let currentSegment = { start: 0, volume: 0, peak: 0, frequency: 0 };
  
  return new Promise((resolve, reject) => {
    ffmpeg(filePath)
      .audioFilters([
        'volumedetect',
        'astats=metadata=1:reset=1',  // Detailed audio statistics
        'ebur128=metadata=1',         // Loudness measurement
        'afreqshift=shift=0:order=8'  // Frequency analysis
      ])
      .outputOptions(['-f', 'null'])
      .output('/dev/null')
      .on('stderr', line => {
        // Parse various audio metrics
        const meanMatch = line.match(/mean_volume:\s+([-\d.]+)\s+dB/);
        const peakMatch = line.match(/max_volume:\s+([-\d.]+)\s+dB/);
        const freqMatch = line.match(/frequency_peak:\s+([-\d.]+)/);
        const loudnessMatch = line.match(/I:\s+([-\d.]+)\s+LUFS/);
        
        if (meanMatch || peakMatch || freqMatch || loudnessMatch) {
          if (meanMatch) currentSegment.volume = parseFloat(meanMatch[1]);
          if (peakMatch) currentSegment.peak = parseFloat(peakMatch[1]);
          if (freqMatch) currentSegment.frequency = parseFloat(freqMatch[1]);
          if (loudnessMatch) {
            currentSegment.loudness = parseFloat(loudnessMatch[1]);
            segments.push({ ...currentSegment });
            currentSegment.start += segmentDuration;
          }
        }
      })
      .on('error', reject)
      .on('end', () => resolve(segments))
      .run();
  });
};

// Emotion characteristics mapping
const emotionPatterns = {
  happy: {
    volume: { min: -20, ideal: -10 },
    tempo: 'fast',
    pitch: 'high',
    audioFilters: [
      'acompressor=threshold=-12:ratio=2:attack=50:release=250', // Dynamic compression
      'highpass=f=200',  // Remove low rumble
      'volume=2'         // Boost volume
    ],
    sceneChangeThreshold: 0.4  // More frequent scene changes for happy/energetic content
  },
  sad: {
    volume: { min: -30, ideal: -20 },
    tempo: 'slow',
    pitch: 'low',
    audioFilters: [
      'acompressor=threshold=-20:ratio=3:attack=100:release=500', // Gentler compression
      'lowpass=f=8000',  // Softer high end
      'volume=1.5'       // Moderate volume boost
    ],
    sceneChangeThreshold: 0.2  // Fewer scene changes for emotional content
  },
  excited: {
    volume: { min: -15, ideal: -8 },
    tempo: 'very fast',
    pitch: 'very high',
    audioFilters: [
      'acompressor=threshold=-10:ratio=2:attack=25:release=150', // Quick compression
      'highpass=f=150',  // Keep energy
      'volume=2.5'       // Higher volume boost
    ],
    sceneChangeThreshold: 0.5  // Most frequent scene changes
  },
  calm: {
    volume: { min: -35, ideal: -25 },
    tempo: 'very slow',
    pitch: 'medium low',
    audioFilters: [
      'acompressor=threshold=-25:ratio=4:attack=150:release=600', // Smooth compression
      'lowpass=f=6000',  // Very soft high end
      'volume=1.2'       // Slight volume boost
    ],
    sceneChangeThreshold: 0.15 // Minimal scene changes
  }
};

// Helper function to detect emotional characteristics in audio
const detectEmotionalCharacteristics = (filePath) => {
  return new Promise((resolve, reject) => {
    const analysis = {
      volume: 0,
      tempo: 0,
      pitch: 0,
      speechRate: 0
    };

    ffmpeg(filePath)
      .audioFilters([
        'astats=metadata=1:reset=1',  // Audio statistics
        'ebur128=metadata=1',         // Loudness
        'afreqshift=shift=0:order=8'  // Frequency analysis
      ])
      .outputOptions(['-f', 'null'])
      .output('/dev/null')
      .on('stderr', line => {
        // Parse audio characteristics
        const volumeMatch = line.match(/loudness_range:\s+([-\d.]+)\s+LUFS/);
        const freqMatch = line.match(/frequency_peak:\s+([-\d.]+)/);
        
        if (volumeMatch) analysis.volume = parseFloat(volumeMatch[1]);
        if (freqMatch) analysis.pitch = parseFloat(freqMatch[1]);
      })
      .on('error', reject)
      .on('end', () => resolve(analysis))
      .run();
  });
};

// Enhanced findBestSegments to consider emotion
const findBestSegments = async (filePath, segments, targetDuration, targetEmotion = null) => {
  // Get all analysis data
  const [speechSegments, sceneChanges, motionData, emotionalChars] = await Promise.all([
    detectSpeechSegments(filePath),
    detectSceneChanges(filePath),
    analyzeMotion(filePath),
    detectEmotionalCharacteristics(filePath)
  ]);

  // Adjust weights based on target emotion
  let weights = {
    volume: 0.25,
    speech: 0.25,
    motion: 0.25,
    sceneChanges: 0.25
  };

  if (targetEmotion && emotionPatterns[targetEmotion]) {
    const pattern = emotionPatterns[targetEmotion];
    
    // Adjust scene detection threshold
    const sceneChanges = await detectSceneChanges(filePath, pattern.sceneChangeThreshold);
    
    // Modify weights based on emotion
    weights = {
      volume: targetEmotion === 'excited' ? 0.3 : 0.25,
      speech: targetEmotion === 'sad' ? 0.3 : 0.25,
      motion: targetEmotion === 'happy' ? 0.3 : 0.25,
      sceneChanges: 0.2
    };
  }

  // Score segments with emotional consideration
  const scoredSegments = segments.map((seg, i) => {
    const start = seg.start;
    const end = start + targetDuration;
    
    // Basic scoring from previous implementation
    const speechCoverage = speechSegments.filter(s => 
      s.start >= start && s.end <= end
    ).reduce((sum, s) => sum + (s.end - s.start), 0) / targetDuration;

    const sceneCount = sceneChanges.filter(t => t >= start && t <= end).length;
    const sceneScore = sceneCount === 0 ? 0 : Math.min(sceneCount / 2, 1);

    const motionScore = motionData.slice(
      Math.floor(start), 
      Math.ceil(end)
    ).reduce((sum, m) => sum + m, 0) / targetDuration;

    // Emotional matching score
    let emotionScore = 1;
    if (targetEmotion && emotionPatterns[targetEmotion]) {
      const pattern = emotionPatterns[targetEmotion];
      const volumeMatch = Math.max(0, 1 - Math.abs(seg.volume - pattern.volume.ideal) / 20);
      emotionScore = volumeMatch;
    }

    return {
      start,
      duration: targetDuration,
      score: (
        weights.volume * seg.normalizedVolume +
        weights.speech * speechCoverage +
        weights.motion * motionScore +
        weights.sceneChanges * sceneScore
      ) * emotionScore
    };
  });

  // Find best segment and adjust for scene changes
  const bestSegment = scoredSegments.reduce((best, current) => 
    current.score > best.score ? current : best
  );

  const nearestSceneChange = sceneChanges.find(t => 
    Math.abs(t - bestSegment.start) < 2
  );

  return {
    start: nearestSceneChange || Math.max(0, bestSegment.start - 1),
    duration: targetDuration,
    emotion: targetEmotion
  };
};

// Enhanced function to detect high-energy segments
const detectHighEnergySegments = async (filePath, targetDuration = 30) => {
  try {
    const metadata = await getVideoMetadata(filePath);
    const duration = metadata.format.duration;
    
    // If video is shorter than target duration, return whole video
    if (duration <= targetDuration) {
      return { start: 0, duration };
    }

    // Multi-pass analysis
    const audioSegments = await analyzeAudioSegments(filePath);
    
    // Normalize audio segments
    const maxVolume = Math.max(...audioSegments.map(s => s.volume));
    const minVolume = Math.min(...audioSegments.map(s => s.volume));
    const normalizedSegments = audioSegments.map(s => ({
      ...s,
      normalizedVolume: (s.volume - minVolume) / (maxVolume - minVolume)
    }));

    // Find best segment using all available data
    const bestSegment = await findBestSegments(filePath, normalizedSegments, targetDuration);

    return bestSegment;

  } catch (err) {
    console.error('Error in multi-pass analysis:', err);
    return { start: 5, duration: 30 }; // Fallback
  }
};

// POST /api/shorts - Download YouTube video and create optimized short
app.post("/api/shorts", async (req, res) => {
  const { url, options = {} } = req.body;
  const {
    targetDuration = 30,
    enhanceAudio = true
  } = options;

  if (!url || !url.startsWith("https://www.youtube.com/watch")) {
    return res.status(400).json({ error: "❌ Invalid YouTube URL" });
  }

  const videoIDMatch = url.match(/[?&]v=([^&]+)/);
  if (!videoIDMatch) {
    return res.status(400).json({ error: "❌ Could not extract video ID" });
  }
  const videoID = videoIDMatch[1];

  const inputPath = path.join(VIDEO_DIR, `${videoID}.mp4`);
  const outputPath = path.join(VIDEO_DIR, `${videoID}-short.mp4`);

  try {
    // Download video using yt-dlp.exe with original quality
    console.log(`Downloading video with yt-dlp: ${url}`);
    const ytDlpArgs = [
      "-f", "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best", // Get best quality MP4
      "--merge-output-format", "mp4",
      "-o", inputPath,
      url,
      "--no-progress"
    ];

    const ytDlpProc = spawn(YTDLP_PATH, ytDlpArgs);

    ytDlpProc.stdout.on("data", (data) => console.log(`yt-dlp stdout: ${data.toString()}`));
    ytDlpProc.stderr.on("data", (data) => console.error(`yt-dlp stderr: ${data.toString()}`));
    
    await new Promise((resolve, reject) => {
      ytDlpProc.on("error", reject);
      ytDlpProc.on("close", code => {
        if (code === 0) resolve();
        else reject(new Error(`yt-dlp exited with code ${code}`));
      });
    });

    // Verify download
    if (!fs.existsSync(inputPath) || fs.statSync(inputPath).size === 0) {
      throw new Error("Downloaded file is invalid");
    }

    console.log("✅ Download complete, analyzing video...");

    // Simple trim without any modifications
      ffmpeg(inputPath)
      .setStartTime(start)
      .setDuration(Math.min(clipDuration, targetDuration))
      .outputOptions([
        '-c:v', 'copy',        // Copy video stream without re-encoding
        '-c:a', 'copy',        // Copy audio stream without re-encoding
        '-avoid_negative_ts', 'make_zero'
      ])
        .output(outputPath)
        .on("end", () => {
          console.log("✅ Short video generated:", outputPath);
          res.download(outputPath, (err) => {
          if (err) console.error("Download error:", err);
          // Cleanup files
          fs.unlink(inputPath, () => {});
          fs.unlink(outputPath, () => {});
          });
        })
        .on("error", (err) => {
          console.error("FFmpeg error:", err);
        res.status(500).json({ error: "❌ FFmpeg failed to process video" });
        })
        .run();

  } catch (err) {
    console.error("Unexpected error:", err);
    res.status(500).json({ error: "❌ " + err.message });
    // Cleanup on error
    if (fs.existsSync(inputPath)) fs.unlink(inputPath, () => {});
    if (fs.existsSync(outputPath)) fs.unlink(outputPath, () => {});
  }
});

app.listen(5000, () => {
  console.log("🚀 Backend running at http://localhost:5000");
});
