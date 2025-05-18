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

const YTDLP_PATH = path.join(__dirname, "yt-dlp.exe"); // your yt-dlp.exe path

// POST /api/shorts - Download YouTube video and clip 30 seconds starting at 5 seconds
app.post("/api/shorts", async (req, res) => {
  const { url } = req.body;

  if (!url || !url.startsWith("https://www.youtube.com/watch")) {
    return res.status(400).json({ error: "❌ Invalid YouTube URL" });
  }

  // Extract video ID from URL
  const videoIDMatch = url.match(/[?&]v=([^&]+)/);
  if (!videoIDMatch) {
    return res.status(400).json({ error: "❌ Could not extract video ID" });
  }
  const videoID = videoIDMatch[1];

  const inputPath = path.join(VIDEO_DIR, `${videoID}.mp4`);
  const outputPath = path.join(VIDEO_DIR, `${videoID}-short.mp4`);

  try {
    // 1. Download video using yt-dlp.exe
    console.log(`Downloading video with yt-dlp: ${url}`);

    // Build yt-dlp command args
    const ytDlpArgs = [
      "-f", "best",
      "-o", inputPath,
      url,
      "--no-progress",
      "--quiet"
    ];

    const ytDlpProc = spawn(YTDLP_PATH, ytDlpArgs);

    ytDlpProc.stdout.on("data", (data) => {
      console.log(`yt-dlp stdout: ${data.toString()}`);
    });

    ytDlpProc.stderr.on("data", (data) => {
      console.error(`yt-dlp stderr: ${data.toString()}`);
    });

    ytDlpProc.on("error", (err) => {
      console.error("yt-dlp spawn error:", err);
      return res.status(500).json({ error: "❌ yt-dlp execution failed" });
    });

    ytDlpProc.on("close", (code) => {
      console.log(`yt-dlp exited with code ${code}`);

      if (code !== 0) {
        return res.status(500).json({ error: "❌ yt-dlp failed to download video" });
      }

      // Check if file exists and size > 0
      if (!fs.existsSync(inputPath)) {
        return res.status(500).json({ error: "❌ Downloaded file not found" });
      }
      const stats = fs.statSync(inputPath);
      if (stats.size === 0) {
        return res.status(500).json({ error: "❌ Downloaded file is empty" });
      }

      console.log("✅ Download complete, starting clip...");

      // 2. Clip 30 seconds starting at 5 seconds using ffmpeg
      ffmpeg(inputPath)
        .setStartTime("00:00:05")
        .setDuration(30)
        .output(outputPath)
        .on("end", () => {
          console.log("✅ Short video generated:", outputPath);

          // Send clipped video file for download
          res.download(outputPath, (err) => {
            if (err) {
              console.error("Download error:", err);
            }

            // Optional: cleanup files after sending
            // fs.unlinkSync(inputPath);
            // fs.unlinkSync(outputPath);
          });
        })
        .on("error", (err) => {
          console.error("FFmpeg error:", err);
          res.status(500).json({ error: "❌ FFmpeg failed to clip video" });
        })
        .run();
    });

  } catch (err) {
    console.error("Unexpected error:", err);
    res.status(500).json({ error: "❌ Unexpected error occurred" });
  }
});

app.listen(5000, () => {
  console.log("🚀 Backend running at http://localhost:5000");
});
