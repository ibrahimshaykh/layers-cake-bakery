// Extracts the scroll frame sequence from the source cake video and writes
// optimized WebP frames with transparent backgrounds to public/frames/.
// Runs at build/dev-prep time only — ffmpeg is never invoked at runtime.
//
// The full take is used, so the scroll plays the whole video through. Note
// that the camera pushes in throughout: past ~4.5s the cake's base leaves
// the bottom of the frame, and the take ends on the slice bursting apart
// rather than landing. That framing is baked into the footage — the hero
// counter-zooms to keep the subject a steady size and dissolves the frame's
// bottom edge, but content the camera cropped cannot be recovered here.
//
// Background: the subject sits on a bright studio sweep. For each frame we
// rebuild the sweep behind the subject (coarse grid + Laplace inpainting)
// and derive alpha from how far each pixel departs from that plate. Both
// the cake's highlights and its soft contact shadow differ from the plate,
// so both survive — unlike a luma key, which eats specular highlights and
// hard-cuts the shadow.
import ffmpegPath from "ffmpeg-static";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  existsSync, mkdirSync, rmSync, openSync, readSync, writeSync, closeSync, statSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

const SOURCE = path.join(projectRoot, "source-media", "cake-sequence-source.mp4");
const OUT_DIR = path.join(projectRoot, "public", "frames");

// The whole take, start to finish.
const CLIP_END = 10;
// 80, not 150. 150 frames at these resolutions is ~11MB, and measurement
// on the deployed site showed the scroll simply outruns it: only 66 of
// 150 frames ever reached the screen on a 10Mbps link, and 114 of 150 even
// unthrottled — the cake visibly froze while the scroll and the text
// carried on, because text costs nothing to "load" and a frame costs
// ~76KB. The reference site this is modelled on uses 67 frames / 7.4MB
// total, which is the honest budget for a scroll-scrubbed sequence. At 80
// frames each one also stays on screen twice as long, so loading has twice
// as long to keep up.
const FORWARD_FRAMES = 80;
// Matte at the source's native resolution — the video is 1920x1080, and
// keying before any downscale avoids matting interpolated edge pixels.
// Both output sets are then scaled down from this.
const WIDTH = 1920;
const HEIGHT = 1080;
// Delivered sets. Both are 16:9 like the source, so the hero's layout
// math (which works from the aspect ratio, not the pixel dimensions) is
// identical for either.
//
// These sizes are a sharpness-vs-decoded-memory trade. The canvas draws
// the frame at roughly the viewport width, times the device pixel ratio:
// ~2500 device px on a Retina laptop, ~1560 on a 390pt phone at DPR 2.
// The previous 1280 / 640 sets were upscaled ~2x into that and looked
// soft. These land much closer to native while keeping the resident
// window affordable (see the window constants in ScrollCakeHero).
const DESKTOP_WIDTH = 1600;
const DESKTOP_HEIGHT = 900;
const MOBILE_OUT_DIR = path.join(projectRoot, "public", "frames-mobile");
const MOBILE_WIDTH = 960;
const MOBILE_HEIGHT = 540;
// 82, not higher: at these resolutions the sharpness win comes almost
// entirely from the pixel count, while quality 90 nearly doubled file size
// (93KB/frame desktop). Bigger frames take longer to arrive, and a loader
// that can't keep up with the scroll is the worse failure — that was the
// original "stuck" complaint.
const WEBP_QUALITY = 82;
// Phones are the tight case: measured on a 1.6Mbps/150ms link, 41KB frames
// left the sequence ~4s behind a full-speed scroll. Resolution is what
// actually makes it look sharper, so keep the pixels and spend less per
// pixel here rather than shipping a smaller frame.
const MOBILE_QUALITY = 72;

// Matte tuning. Differences below DEAD_ZONE are backdrop noise; differences
// at or above FULL_OPAQUE are solid subject. The subject is darker than the
// sweep, so pixels brighter than the plate need a much larger departure
// before they count — that keeps studio bounce light off the page.
const DEAD_ZONE = 15;
const FULL_OPAQUE = 44;
// Every part of the subject is darker than the sweep, so anything brighter
// than the plate is bounce light pooling on the backdrop. The thresholds
// below are set past what the footage ever reaches, which drops that pool
// entirely while leaving a margin in case a true specular glint appears.
const BRIGHT_DEAD_ZONE = 92;
const BRIGHT_FULL_OPAQUE = 140;

// Backdrop plate reconstruction.
const CELL = 16; // px per coarse grid cell
// Measured on this footage: the subject sits at luma 28-140, the sweep at
// 214-244. A drop of 40 puts the cutoff (~200) in that gap with margin on
// both sides.
const SUBJECT_LUMA_DROP = 40; // how far below backdrop level reads as subject
const MASK_DILATE = 2; // cells, to catch soft shadow and edges
const INPAINT_ITERATIONS = 600;
// No border guard: over the full take the cake's base runs off the bottom
// of the frame and flying chocolate reaches the top and sides, so forcing
// edge cells to "backdrop" would punch holes through real subject. The
// luma cutoff above already clears the sweep's dark corners by ~14 levels.

const GRID_W = Math.ceil(WIDTH / CELL);
const GRID_H = Math.ceil(HEIGHT / CELL);

function luma(r, g, b) {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// Average each CELL x CELL block into a coarse RGB grid.
function buildGrid(rgb, grid) {
  for (let gy = 0; gy < GRID_H; gy++) {
    const y0 = gy * CELL;
    const y1 = Math.min(y0 + CELL, HEIGHT);
    for (let gx = 0; gx < GRID_W; gx++) {
      const x0 = gx * CELL;
      const x1 = Math.min(x0 + CELL, WIDTH);
      let r = 0, g = 0, b = 0, n = 0;
      for (let y = y0; y < y1; y++) {
        let i = (y * WIDTH + x0) * 3;
        for (let x = x0; x < x1; x++) {
          r += rgb[i]; g += rgb[i + 1]; b += rgb[i + 2];
          i += 3; n++;
        }
      }
      const gi = (gy * GRID_W + gx) * 3;
      grid[gi] = r / n;
      grid[gi + 1] = g / n;
      grid[gi + 2] = b / n;
    }
  }
}

// Mark cells that read as subject (well below the frame's backdrop level).
function buildSubjectMask(grid, mask) {
  const lumas = new Float64Array(GRID_W * GRID_H);
  for (let i = 0; i < lumas.length; i++) {
    const gi = i * 3;
    lumas[i] = luma(grid[gi], grid[gi + 1], grid[gi + 2]);
  }
  const sorted = Float64Array.from(lumas).sort();
  const backdropLevel = sorted[Math.floor(sorted.length * 0.85)];
  const cutoff = backdropLevel - SUBJECT_LUMA_DROP;

  for (let i = 0; i < lumas.length; i++) mask[i] = lumas[i] < cutoff ? 1 : 0;

  // Dilate so soft shadow and anti-aliased edges are treated as unknown.
  for (let pass = 0; pass < MASK_DILATE; pass++) {
    const prev = Uint8Array.from(mask);
    for (let gy = 0; gy < GRID_H; gy++) {
      for (let gx = 0; gx < GRID_W; gx++) {
        if (prev[gy * GRID_W + gx]) continue;
        const up = gy > 0 && prev[(gy - 1) * GRID_W + gx];
        const down = gy < GRID_H - 1 && prev[(gy + 1) * GRID_W + gx];
        const left = gx > 0 && prev[gy * GRID_W + gx - 1];
        const right = gx < GRID_W - 1 && prev[gy * GRID_W + gx + 1];
        if (up || down || left || right) mask[gy * GRID_W + gx] = 1;
      }
    }
  }

}

// Fill masked cells by averaging their neighbours until the surface is smooth.
function inpaintGrid(grid, mask) {
  // Seed unknown cells with the mean of the known ones.
  let sr = 0, sg = 0, sb = 0, n = 0;
  for (let i = 0; i < mask.length; i++) {
    if (mask[i]) continue;
    const gi = i * 3;
    sr += grid[gi]; sg += grid[gi + 1]; sb += grid[gi + 2]; n++;
  }
  if (!n) return;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    const gi = i * 3;
    grid[gi] = sr / n; grid[gi + 1] = sg / n; grid[gi + 2] = sb / n;
  }

  const next = Float64Array.from(grid);
  for (let it = 0; it < INPAINT_ITERATIONS; it++) {
    for (let gy = 0; gy < GRID_H; gy++) {
      for (let gx = 0; gx < GRID_W; gx++) {
        const idx = gy * GRID_W + gx;
        if (!mask[idx]) continue;
        const gi = idx * 3;
        for (let c = 0; c < 3; c++) {
          let sum = 0, count = 0;
          if (gy > 0) { sum += grid[((gy - 1) * GRID_W + gx) * 3 + c]; count++; }
          if (gy < GRID_H - 1) { sum += grid[((gy + 1) * GRID_W + gx) * 3 + c]; count++; }
          if (gx > 0) { sum += grid[(gy * GRID_W + gx - 1) * 3 + c]; count++; }
          if (gx < GRID_W - 1) { sum += grid[(gy * GRID_W + gx + 1) * 3 + c]; count++; }
          next[gi + c] = sum / count;
        }
      }
    }
    for (let i = 0; i < mask.length; i++) {
      if (!mask[i]) continue;
      const gi = i * 3;
      grid[gi] = next[gi]; grid[gi + 1] = next[gi + 1]; grid[gi + 2] = next[gi + 2];
    }
  }
}

// Bilinear sample of the coarse plate at a full-res pixel.
function samplePlate(grid, x, y, out) {
  const fx = Math.min(GRID_W - 1.001, Math.max(0, (x + 0.5) / CELL - 0.5));
  const fy = Math.min(GRID_H - 1.001, Math.max(0, (y + 0.5) / CELL - 0.5));
  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  const tx = fx - x0, ty = fy - y0;
  const i00 = (y0 * GRID_W + x0) * 3;
  const i10 = (y0 * GRID_W + x0 + 1) * 3;
  const i01 = ((y0 + 1) * GRID_W + x0) * 3;
  const i11 = ((y0 + 1) * GRID_W + x0 + 1) * 3;
  for (let c = 0; c < 3; c++) {
    const top = grid[i00 + c] * (1 - tx) + grid[i10 + c] * tx;
    const bottom = grid[i01 + c] * (1 - tx) + grid[i11 + c] * tx;
    out[c] = top * (1 - ty) + bottom * ty;
  }
}

// Per-pixel multiplier that dissolves the frame's own top and side edges,
// where the camera crops flying chocolate mid-air. This used to be done at
// runtime with four destination-out gradient fills per drawn frame, which
// measured as the dominant cost of the scroll: destination-out is a slow
// compositing path, and on a Retina laptop those fills covered a
// 2850x1800 canvas every frame (p90 frame time 132ms under 4x CPU
// throttle). It's a fixed function of position, so it belongs in the
// alpha channel at build time — the runtime then only clears and draws.
// The bottom edge is deliberately not faded: the hero anchors the frame
// past the bottom of the viewport, so that edge is off screen anyway.
const EDGE_FADE_TOP = 0.06;
const EDGE_FADE_SIDE = 0.05;

function edgeFadeAt(x, y) {
  const topBand = HEIGHT * EDGE_FADE_TOP;
  const sideBand = WIDTH * EDGE_FADE_SIDE;
  let f = 1;
  if (y < topBand) f = Math.min(f, y / topBand);
  if (x < sideBand) f = Math.min(f, x / sideBand);
  if (x > WIDTH - 1 - sideBand) f = Math.min(f, (WIDTH - 1 - x) / sideBand);
  return f;
}

function matteFrame(rgb, rgba, grid, mask) {
  buildGrid(rgb, grid);
  buildSubjectMask(grid, mask);
  inpaintGrid(grid, mask);

  const plate = [0, 0, 0];
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      samplePlate(grid, x, y, plate);
      const si = (y * WIDTH + x) * 3;
      const r = rgb[si], g = rgb[si + 1], b = rgb[si + 2];

      const diff = Math.max(
        Math.abs(r - plate[0]),
        Math.abs(g - plate[1]),
        Math.abs(b - plate[2])
      );
      const brighter = r + g + b > plate[0] + plate[1] + plate[2];
      const dead = brighter ? BRIGHT_DEAD_ZONE : DEAD_ZONE;
      const solid = brighter ? BRIGHT_FULL_OPAQUE : FULL_OPAQUE;

      let a;
      if (diff <= dead) a = 0;
      else if (diff >= solid) a = 255;
      else a = Math.round(((diff - dead) / (solid - dead)) * 255);

      if (a > 0) a = Math.round(a * edgeFadeAt(x, y));

      const di = (y * WIDTH + x) * 4;
      rgba[di] = r; rgba[di + 1] = g; rgba[di + 2] = b; rgba[di + 3] = a;
    }
  }
}

async function main() {
  if (!existsSync(SOURCE)) {
    console.error(`Source video not found at ${SOURCE}`);
    process.exit(1);
  }

  const tmpDir = path.join(os.tmpdir(), `layers-frames-${process.pid}`);
  mkdirSync(tmpDir, { recursive: true });
  const rgbPath = path.join(tmpDir, "frames.rgb");
  const rgbaPath = path.join(tmpDir, "frames.rgba");

  try {
    const fps = FORWARD_FRAMES / CLIP_END;

    console.log(`Decoding ${FORWARD_FRAMES} frames from the first ${CLIP_END}s...`);
    await execFileAsync(ffmpegPath, [
      "-y", "-v", "error",
      "-t", String(CLIP_END),
      "-i", SOURCE,
      "-vf", `fps=${fps},scale=${WIDTH}:${HEIGHT}:flags=lanczos`,
      "-vframes", String(FORWARD_FRAMES),
      "-f", "rawvideo", "-pix_fmt", "rgb24",
      rgbPath,
    ]);

    const frameBytesRgb = WIDTH * HEIGHT * 3;
    const frameBytesRgba = WIDTH * HEIGHT * 4;
    const available = Math.min(
      FORWARD_FRAMES,
      Math.floor(statSync(rgbPath).size / frameBytesRgb)
    );
    if (available < FORWARD_FRAMES) {
      console.warn(`Only ${available} frames decoded (wanted ${FORWARD_FRAMES}).`);
    }

    console.log("Matting the studio sweep out of each frame...");
    const rgb = Buffer.alloc(frameBytesRgb);
    const rgba = Buffer.alloc(frameBytesRgba);
    const grid = new Float64Array(GRID_W * GRID_H * 3);
    const mask = new Uint8Array(GRID_W * GRID_H);
    const inFd = openSync(rgbPath, "r");
    const outFd = openSync(rgbaPath, "w");
    try {
      for (let i = 0; i < available; i++) {
        readSync(inFd, rgb, 0, frameBytesRgb, i * frameBytesRgb);
        matteFrame(rgb, rgba, grid, mask);
        writeSync(outFd, rgba, 0, frameBytesRgba);
        if ((i + 1) % 20 === 0) console.log(`  ${i + 1}/${available}`);
      }
    } finally {
      closeSync(inFd);
      closeSync(outFd);
    }

    rmSync(OUT_DIR, { recursive: true, force: true });
    mkdirSync(OUT_DIR, { recursive: true });

    console.log(`Encoding ${available} transparent WebP frames (${DESKTOP_WIDTH}x${DESKTOP_HEIGHT})...`);
    await execFileAsync(ffmpegPath, [
      "-y", "-v", "error",
      "-f", "rawvideo", "-pix_fmt", "rgba",
      "-s", `${WIDTH}x${HEIGHT}`,
      "-i", rgbaPath,
      "-vf", `scale=${DESKTOP_WIDTH}:${DESKTOP_HEIGHT}:flags=lanczos`,
      "-c:v", "libwebp",
      "-quality", String(WEBP_QUALITY),
      "-preset", "photo",
      path.join(OUT_DIR, "frame-%03d.webp"),
    ]);

    // Phone-sized variant. What matters here is not download size — the
    // frames are already small — but *decoded* size. A browser holding
    // this sequence resident costs width*height*4 bytes per frame: at
    // 1280x720 that's ~527MB for the full set, which a desktop absorbs
    // silently and a phone cannot. iOS Safari in particular has a hard
    // per-tab memory ceiling well below that, so it evicts frames and
    // has to re-decode them mid-scroll — which is what makes the
    // animation stall on a real device while looking perfect in desktop
    // testing. At MOBILE_WIDTH the same set is ~4x cheaper to hold.
    rmSync(MOBILE_OUT_DIR, { recursive: true, force: true });
    mkdirSync(MOBILE_OUT_DIR, { recursive: true });

    console.log(`Encoding ${available} phone-sized frames (${MOBILE_WIDTH}x${MOBILE_HEIGHT})...`);
    await execFileAsync(ffmpegPath, [
      "-y", "-v", "error",
      "-f", "rawvideo", "-pix_fmt", "rgba",
      "-s", `${WIDTH}x${HEIGHT}`,
      "-i", rgbaPath,
      "-vf", `scale=${MOBILE_WIDTH}:${MOBILE_HEIGHT}:flags=lanczos`,
      "-c:v", "libwebp",
      "-quality", String(MOBILE_QUALITY),
      "-preset", "photo",
      path.join(MOBILE_OUT_DIR, "frame-%03d.webp"),
    ]);

    console.log(`Done. ${available} frames written to ${OUT_DIR} and ${MOBILE_OUT_DIR}`);
    console.log(`Set FRAME_COUNT in ScrollCakeHero.tsx to ${available}.`);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
