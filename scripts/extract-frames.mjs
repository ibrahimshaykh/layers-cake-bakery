// Extracts an evenly-sampled frame sequence from the source cake video and
// writes optimized WebP frames to public/frames/. Runs at build/dev-prep
// time only — ffmpeg is never invoked at runtime.
import ffmpegPath from "ffmpeg-static";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

const SOURCE = path.join(projectRoot, "source-media", "cake-sequence-source.mp4");
const OUT_DIR = path.join(projectRoot, "public", "frames");
const FRAME_COUNT = 150;
const DURATION_SECONDS = 10;
const TARGET_WIDTH = 1280;
const WEBP_QUALITY = 75;

async function main() {
  if (!existsSync(SOURCE)) {
    console.error(`Source video not found at ${SOURCE}`);
    process.exit(1);
  }

  rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });

  const fps = FRAME_COUNT / DURATION_SECONDS; // 15fps -> 150 frames over 10s
  const outputPattern = path.join(OUT_DIR, "frame-%03d.webp");

  const args = [
    "-y",
    "-i", SOURCE,
    "-vf", `fps=${fps},scale=${TARGET_WIDTH}:-1:flags=lanczos`,
    "-vframes", String(FRAME_COUNT),
    "-c:v", "libwebp",
    "-quality", String(WEBP_QUALITY),
    "-preset", "photo",
    outputPattern,
  ];

  console.log(`Extracting ${FRAME_COUNT} frames at ${fps}fps, ${TARGET_WIDTH}px wide...`);
  await execFileAsync(ffmpegPath, args);
  console.log(`Done. Frames written to ${OUT_DIR}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
