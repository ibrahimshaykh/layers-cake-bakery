"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import gsap from "gsap";
import ScrollTrigger from "gsap/ScrollTrigger";
import { hero } from "@/content/site";

// Must match FORWARD_FRAMES in scripts/extract-frames.mjs. Kept at 80
// rather than 150 because the scroll outran loading at 150 — see the
// comment there for the measurements.
const FRAME_COUNT = 80;
// The decode window (see the loader effect for the full reasoning).
//
// AHEAD/BEHIND set how far decoding *leads* and *trails* the scroll, in
// whichever direction it's travelling. Retention is symmetric at
// (AHEAD + MARGIN) either side, so turning around always lands on frames
// that are still decoded — an asymmetric keep-range was what made
// reversing stutter. MARGIN is also hysteresis, so frames at the edge
// aren't dropped and re-decoded as the scroll jitters.
//
// That retention is the memory bound: (2*(AHEAD+MARGIN)+1) frames, each
// costing width*height*4 bytes decoded — 5.8MB at 1600x900, 2.1MB at
// 960x540. So ~35 frames means ~200MB desktop, ~72MB mobile.
const WINDOW_DESKTOP = { ahead: 12, behind: 8, margin: 5 };
const WINDOW_MOBILE = { ahead: 12, behind: 8, margin: 5 };
// Decodes are off-thread and cheap next to a network round trip, so this
// can run wider than the old network concurrency did. Raising it to 16
// was tried and measured no better on a reversal (the bottleneck is total
// decode work, not parallelism), so it stays here.
const MAX_CONCURRENT_DECODES = 8;
// Decode the desktop set slightly smaller than its stored 1600px. Decode
// cost scales with output pixels, and a reversal has to rebuild a stretch
// of frames at once — that was the one case still stalling. The canvas
// draws the frame at roughly 1580 device px on a Retina laptop, so this
// is a ~1.2x upscale, far less than the ~2x the original 1280 set had.
// The phone set is already small enough to decode natively.
const DECODE_WIDTH_DESKTOP = 1280;
// How many frames' bytes to fetch in parallel while filling the byte cache.
const FETCH_CONCURRENCY = 10;
// How far from the wanted frame to look for an already-decoded one to show
// instead, when the scroll has outrun decoding.
const NEAREST_FRAME_SEARCH = 40;
const PIN_HEIGHT_VH = 320; // scroll distance the sequence plays across

// The cake is drawn "contain"-fit (whole subject always visible) and then
// scaled down so it floats with breathing room, like a product shot.
// The frames carry their own alpha, so nothing but the cake is painted.
const FIT_SCALE = 0.88;
// On portrait screens a contain-fit would shrink the cake to a speck, since
// the subject only fills the middle of a 16:9 frame. There we size by width
// instead and let the frame's empty (transparent) sides run off screen.
// These were originally tuned low (1.7 / 0.6) and left the cake noticeably
// smaller than on desktop — late in the sequence the base decoration was
// squeezed into a sliver a few dozen px tall at the very bottom edge.
// Raised to match desktop's presence: MAX_HEIGHT close to FIT_SCALE above,
// and WIDTH_FACTOR high enough that height, not width, is what binds.
const PORTRAIT_WIDTH_FACTOR = 2;
const PORTRAIT_MAX_HEIGHT = 0.62;
// The dissolve on the frame's cropped top and side edges lives in the
// frames' alpha channel now (see edgeFadeAt in scripts/extract-frames.mjs),
// not in a runtime compositing pass.
//
// How far below the viewport's bottom edge the frame is anchored, as a
// fraction of the drawn frame height.
const BOTTOM_OVERSHOOT = 0.04;
// Ceiling on the canvas backing store width, in device pixels. Honouring
// devicePixelRatio blindly gave a 2850px-wide canvas on a Retina laptop —
// 5.1M pixels to clear and redraw per frame — for no visible gain, since
// the source frames are only 1600 (desktop) and 960 (mobile) wide. Capping
// just past the source resolution keeps the same sharpness for a fraction
// of the fill cost.
const MAX_CANVAS_WIDTH_DESKTOP = 1800;
const MAX_CANVAS_WIDTH_MOBILE = 1100;
// No counter-zoom: the source's own push-in is what makes the cake fill
// more of the screen as you scroll, base and all, the same way it plays in
// the original video. An earlier version shrank later frames to keep the
// subject a "steady size", but that also shrank the base out of view well
// before the camera actually cropped it — undoing the exact moment the
// push-in is meant to deliver.

// Phones get the smaller frame set. This is a decoded-memory decision, not
// a bandwidth one — see the preload effect below. Kept in sync with the
// matching <link rel="preload" media=...> hints in app/layout.tsx.
const SMALL_SCREEN_QUERY = "(max-width: 820px)";
let onSmallScreenCache: boolean | null = null;
function onSmallScreen() {
  if (onSmallScreenCache === null) {
    onSmallScreenCache =
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia(SMALL_SCREEN_QUERY).matches;
  }
  return onSmallScreenCache;
}

function frameUrl(index: number) {
  const n = String(index + 1).padStart(3, "0");
  return `${onSmallScreen() ? "/frames-mobile" : "/frames"}/frame-${n}.webp`;
}

function frameWindow() {
  return onSmallScreen() ? WINDOW_MOBILE : WINDOW_DESKTOP;
}

// Both frame sets are 16:9 like the source, so this is only ever used as
// an aspect ratio — the layout is identical whichever set is in play, and
// it never has to touch an actual <img> to work it out.
const NATIVE_WIDTH = 1280;
const NATIVE_HEIGHT = 720;

// An ImageBitmap normally, or an <img> on the rare browser without
// createImageBitmap. Both are valid drawImage sources.
type FrameSource = ImageBitmap | HTMLImageElement;

type Layout = {
  dx: number;
  dy: number;
  drawWidth: number;
  drawHeight: number;
};

function computeLayout(cssWidth: number, cssHeight: number): Layout {
  let scale;
  if (cssHeight > cssWidth) {
    scale = (cssWidth * PORTRAIT_WIDTH_FACTOR) / NATIVE_WIDTH;
    const maxHeight = cssHeight * PORTRAIT_MAX_HEIGHT;
    if (NATIVE_HEIGHT * scale > maxHeight) {
      scale = maxHeight / NATIVE_HEIGHT;
    }
  } else {
    scale = Math.min(cssWidth / NATIVE_WIDTH, cssHeight / NATIVE_HEIGHT) * FIT_SCALE;
  }

  const drawWidth = NATIVE_WIDTH * scale;
  const drawHeight = NATIVE_HEIGHT * scale;
  const dx = (cssWidth - drawWidth) / 2;
  const dy = cssHeight - drawHeight + drawHeight * BOTTOM_OVERSHOOT;

  return { dx, dy, drawWidth, drawHeight };
}

export default function ScrollCakeHero() {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const tiltRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const framesRef = useRef<Array<FrameSource | undefined>>([]);
  // Two refs, not one: targetFrameRef is "what scroll currently wants
  // shown", updated on every onUpdate regardless of whether that frame's
  // image has arrived yet. drawnFrameRef is "what's actually on the
  // canvas", only updated when a draw succeeds. Collapsing these into one
  // ref previously meant that if a frame's image arrived late — a real
  // possibility since frames stream in behind the visible hero — the
  // target got marked "handled" the moment it was requested, so the
  // now-skip-if-unchanged draw call below never got a second chance to
  // paint it once the image showed up. The frame would just never appear.
  const targetFrameRef = useRef(0);
  const drawnFrameRef = useRef(-1);
  const layoutRef = useRef<{ layout: Layout; cssWidth: number; cssHeight: number; dpr: number } | null>(null);
  // "Latest ref" for drawFrame: the preload effect below is defined before
  // drawFrame exists and only needs to call it when an image arrives late,
  // so it reads through this instead of drawFrame being an effect dep.
  const drawFrameRef = useRef<(index: number) => boolean>(() => false);
  // Nudges the loader to re-evaluate its window against wherever the scroll
  // now is (it reads targetFrameRef itself, so it needs no argument). Set
  // once the preload effect below has a real implementation.
  const requestFrameWindowRef = useRef<() => void>(() => {});
  const [imagesReady, setImagesReady] = useState(false);

  // Two stages: get all the bytes, then decode a window of them.
  //
  // Stage 1 fetches every frame's compressed bytes into memory. The whole
  // sequence is only ~5.9MB desktop / ~2.8MB mobile, so this is cheap, and
  // it takes the network out of the scroll entirely. That matters because
  // no prefetch window can win against a fast flick: a hard scroll crosses
  // the whole sequence in about a second, and 80 round trips do not fit in
  // a second on any connection. Once the bytes are local, the only cost
  // left is decode.
  //
  // Stage 2 keeps a window of *decoded* frames around the scroll position.
  // Decoded frames are what cost real memory (5.8MB each at 1600x900,
  // 2.1MB at 960x540), far too much to hold all of — a phone in particular
  // will evict and re-decode, which is what made this stall in the first
  // place. So the window is bounded and releases what it passes, but
  // refilling it now only needs a decode from a local blob, no request.
  //
  // The window follows the direction of travel. It used to be fixed at 14
  // ahead / 6 behind, which left scrolling *up* with less than half the
  // runway of scrolling down — reported as reverse being noticeably worse.
  useEffect(() => {
    let cancelled = false;
    const blobs: Array<Blob | undefined> = new Array(FRAME_COUNT);
    const frames: Array<FrameSource | undefined> = new Array(FRAME_COUNT);
    // 0 = not decoded, 1 = decoding, 2 = ready
    const state = new Uint8Array(FRAME_COUNT);
    let decoding = 0;
    let lastTarget = 0;
    // +1 scrolling down the sequence, -1 scrolling back up.
    let direction = 1;

    const release = (i: number) => {
      if (state[i] !== 2) return;
      const frame = frames[i];
      // close() frees the decoded pixels immediately and deterministically.
      if (frame && "close" in frame) frame.close();
      frames[i] = undefined;
      state[i] = 0;
    };

    // Draw the closest frame to the target that's actually decoded.
    // Without this the hero freezes on whichever frame last landed
    // whenever the scroll gets ahead of decoding; showing the nearest
    // available frame keeps the cake tracking the scroll, just coarsely,
    // and it sharpens as frames land.
    function paintBestAvailable() {
      if (cancelled) return;
      const target = targetFrameRef.current;
      const drawn = drawnFrameRef.current;
      // Never let the substitute run against the scroll, or a gap in
      // what's decoded makes the cake visibly jump backwards.
      const forward = target >= drawn;
      for (let d = 0; d <= NEAREST_FRAME_SEARCH; d++) {
        const ahead = target + d;
        if (ahead < FRAME_COUNT && state[ahead] === 2 && (!forward || ahead >= drawn)) {
          if (ahead !== drawn && drawFrameRef.current(ahead)) drawnFrameRef.current = ahead;
          return;
        }
        if (d === 0) continue;
        const behind = target - d;
        if (behind >= 0 && state[behind] === 2 && (forward ? behind >= drawn : behind <= drawn)) {
          if (behind !== drawn && drawFrameRef.current(behind)) drawnFrameRef.current = behind;
          return;
        }
      }
    }

    const startDecode = (i: number) => {
      if (cancelled || state[i] !== 0 || !blobs[i]) return;
      state[i] = 1;
      decoding++;
      let settled = false;
      const settle = () => {
        if (settled) return false;
        settled = true;
        decoding--;
        return true;
      };
      const succeed = (frame: FrameSource) => {
        if (!settle()) return;
        if (cancelled || state[i] !== 1) {
          if ("close" in frame) frame.close();
          return;
        }
        frames[i] = frame;
        state[i] = 2;
        if (i === 0) setImagesReady(true);
        paintBestAvailable();
        pumpDecode();
      };
      const fail = () => {
        if (!settle()) return;
        if (state[i] === 1) state[i] = 0;
        if (!cancelled) pumpDecode();
      };

      // An ImageBitmap is decoded once, off the main thread, and stays
      // decoded until closed — unlike a detached <img>, whose decoded
      // pixels Chromium is free to discard, making every drawImage pay a
      // fresh WebP-with-alpha decode.
      if (typeof createImageBitmap === "function") {
        const opts = onSmallScreen()
          ? undefined
          : {
              resizeWidth: DECODE_WIDTH_DESKTOP,
              resizeHeight: Math.round((DECODE_WIDTH_DESKTOP * NATIVE_HEIGHT) / NATIVE_WIDTH),
              resizeQuality: "high" as const,
            };
        createImageBitmap(blobs[i] as Blob, opts).then(succeed).catch(fail);
        return;
      }
      const img = new Image();
      const url = URL.createObjectURL(blobs[i] as Blob);
      img.src = url;
      img.onload = () => {
        const done = () => {
          URL.revokeObjectURL(url);
          succeed(img);
        };
        if (img.decode) img.decode().catch(() => {}).finally(done);
        else done();
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        fail();
      };
    };

    // Decode *order* leads in the direction of travel, but what's kept is
    // symmetric around the scroll.
    //
    // Those are deliberately different. An asymmetric keep-range is what
    // made reversing worse: with 14 frames retained ahead and only 6
    // behind, the instant you turned around your runway was those 6, and
    // everything else had to be decoded from scratch while the scroll was
    // already moving. Measured on desktop, reversing immediately after a
    // pass down: worst stall 11 rAFs (~180ms) against 5 (~80ms) going
    // down. Keeping the same distance either side means a reversal finds
    // frames already decoded, at the cost of holding a few more.
    function pumpDecode() {
      if (cancelled) return;
      const target = targetFrameRef.current;
      const win = frameWindow();
      const keep = win.ahead + win.margin;

      const keepLo = Math.max(0, target - keep);
      const keepHi = Math.min(FRAME_COUNT - 1, target + keep);
      for (let i = 0; i < FRAME_COUNT; i++) {
        if (i < keepLo || i > keepHi) release(i);
      }

      // Lead in the direction of travel; trail behind it.
      const lead = win.ahead;
      const trail = win.behind;
      for (let d = 0; d <= Math.max(lead, trail); d++) {
        if (decoding >= MAX_CONCURRENT_DECODES) return;
        const fwd = target + (direction >= 0 ? d : -d);
        if (d <= lead && fwd >= 0 && fwd < FRAME_COUNT) startDecode(fwd);
        if (d === 0) continue;
        if (decoding >= MAX_CONCURRENT_DECODES) return;
        const back = target - (direction >= 0 ? d : -d);
        if (d <= trail && back >= 0 && back < FRAME_COUNT) startDecode(back);
      }
    }

    requestFrameWindowRef.current = () => {
      const target = targetFrameRef.current;
      if (target !== lastTarget) {
        direction = target > lastTarget ? 1 : -1;
        lastTarget = target;
      }
      paintBestAvailable();
      pumpDecode();
    };

    framesRef.current = frames;

    // Stage 1. Frame 0 first so the hero can reveal as early as possible,
    // then the rest in parallel batches.
    const fetchFrame = (i: number) =>
      fetch(frameUrl(i))
        .then((res) => (res.ok ? res.blob() : Promise.reject(new Error(String(res.status)))))
        .then((blob) => {
          if (cancelled) return;
          blobs[i] = blob;
          // Decode straight away if the scroll already wants this one.
          if (Math.abs(i - targetFrameRef.current) <= 1) startDecode(i);
        })
        .catch(() => {});

    (async () => {
      await fetchFrame(0);
      if (cancelled) return;
      startDecode(0);
      pumpDecode();
      for (let i = 1; i < FRAME_COUNT; i += FETCH_CONCURRENCY) {
        if (cancelled) return;
        const batch = [];
        for (let j = i; j < Math.min(i + FETCH_CONCURRENCY, FRAME_COUNT); j++) {
          batch.push(fetchFrame(j));
        }
        await Promise.all(batch);
        pumpDecode();
      }
    })();

    return () => {
      cancelled = true;
      for (let i = 0; i < FRAME_COUNT; i++) release(i);
    };
  }, []);

  // Layout (position and scale) is identical for every frame at a given
  // canvas size — nothing here depends on which frame is showing — so it's
  // computed once per size change instead of once per scroll tick.
  const getLayout = useCallback(
    (cssWidth: number, cssHeight: number, dpr: number) => {
      const cached = layoutRef.current;
      if (cached && cached.cssWidth === cssWidth && cached.cssHeight === cssHeight && cached.dpr === dpr) {
        return cached.layout;
      }
      const layout = computeLayout(cssWidth, cssHeight);
      layoutRef.current = { layout, cssWidth, cssHeight, dpr };
      return layout;
    },
    []
  );

  // Draw the current frame: contained, anchored to the bottom. Just a clear
  // and one drawImage — the edge dissolve is baked into the frames' alpha
  // at build time rather than composited here, because doing it at runtime
  // dominated frame cost. Returns whether it actually painted, so callers
  // can tell "drew it" apart from "this frame's image isn't ready yet" and
  // retry later instead of treating a skipped draw as done.
  const drawFrame = useCallback((index: number): boolean => {
    const canvas = canvasRef.current;
    const frame = framesRef.current[index];
    if (!canvas || !frame) return false;
    if (frame instanceof HTMLImageElement && (!frame.complete || frame.naturalWidth === 0)) {
      return false;
    }

    const ctx = canvas.getContext("2d");
    if (!ctx) return false;

    const cssWidth = canvas.clientWidth;
    const cssHeight = canvas.clientHeight;
    // Cap the backing store instead of always honouring devicePixelRatio.
    // At DPR 2 a 1425px-wide hero means a 2850x1800 canvas — 5.1M pixels
    // cleared and redrawn every frame, measured at a p90 of 132ms under
    // 4x CPU throttle. There's nothing to gain past the source frame's own
    // resolution, so cap near it: same sharpness, ~2.5x less pixel work.
    const maxWidth = onSmallScreen() ? MAX_CANVAS_WIDTH_MOBILE : MAX_CANVAS_WIDTH_DESKTOP;
    const dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, 2, maxWidth / cssWidth));
    const targetW = Math.round(cssWidth * dpr);
    const targetH = Math.round(cssHeight * dpr);
    if (canvas.width !== targetW || canvas.height !== targetH) {
      canvas.width = targetW;
      canvas.height = targetH;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssWidth, cssHeight);

    const { dx, dy, drawWidth, drawHeight } = getLayout(cssWidth, cssHeight, dpr);
    ctx.drawImage(frame, dx, dy, drawWidth, drawHeight);
    return true;
  }, [getLayout]);

  useEffect(() => {
    drawFrameRef.current = drawFrame;
  }, [drawFrame]);

  // Scroll-driven frame scrub + checkpoint text reveals.
  useEffect(() => {
    if (!imagesReady) return;
    gsap.registerPlugin(ScrollTrigger);
    // Without this, ScrollTrigger recalculates the whole pin on the
    // address-bar-driven resize events mobile browsers fire mid-scroll,
    // which is a well-known source of stutter/pin-jump on phones.
    ScrollTrigger.config({ ignoreMobileResize: true });

    if (drawFrame(0)) drawnFrameRef.current = 0;

    const wrapper = wrapperRef.current;
    if (!wrapper) return;

    const checkpointEls = hero.checkpoints.map((_, i) =>
      wrapper.querySelectorAll<HTMLElement>(`[data-checkpoint="${i}"]`)
    );
    checkpointEls.forEach((els) => gsap.set(els, { opacity: 0, y: 16 }));

    // Show/hide the checkpoint whose range covers this scroll progress.
    const syncCheckpoints = (progress: number, immediate = false) => {
      hero.checkpoints.forEach((cp, i) => {
        const els = checkpointEls[i];
        if (!els.length) return;
        const next = hero.checkpoints[i + 1]?.progress ?? Infinity;
        // Contiguous ranges — no gap between one checkpoint ending and the
        // next beginning. An earlier `next - 0.02` left a dead band where
        // no heading was shown at all, so stopping the scroll inside it
        // (~2% of the pin, twice over) left the hero with no headline.
        // The 0.3s tween already crossfades out/in, so nothing is gained
        // by also blanking the overlap.
        const inRange = progress >= cp.progress && progress < next;
        const targetOpacity = inRange ? 1 : 0;
        if (Number(els[0].dataset.targetOpacity) === targetOpacity) return;
        els.forEach((el) => {
          el.dataset.targetOpacity = String(targetOpacity);
        });
        gsap.to(els, {
          opacity: targetOpacity,
          y: inRange ? 0 : 16,
          duration: immediate ? 0 : 0.3,
          overwrite: "auto",
        });
      });
    };

    const st = ScrollTrigger.create({
      trigger: wrapper,
      start: "top top",
      end: `+=${PIN_HEIGHT_VH}%`,
      pin: true,
      // Near 1:1 with the scroll. This was 0.4, which is 0.4s of easing
      // between the scroll and the animation: measured at 246ms of the
      // cake still catching up *after* a fast flick had already stopped.
      // On a hard scroll — in either direction — that reads as the cake
      // lagging behind and then snapping, which is what "stucks when I
      // scroll fast" was describing. Small enough to still absorb
      // wheel-tick jitter, short enough not to feel detached.
      scrub: 0.12,
      onUpdate: (self) => {
        // scrub smoothing fires this far more often than the discrete
        // frame actually advances — redrawing on every tick regardless
        // was the main source of scroll jank, so only touch the canvas
        // when there's a new frame to show. targetFrameRef always tracks
        // what scroll wants; drawnFrameRef only advances on a successful
        // paint, so a frame whose image hasn't streamed in yet gets
        // retried (see the preload effect) instead of silently skipped.
        const frame = Math.min(
          FRAME_COUNT - 1,
          Math.floor(self.progress * FRAME_COUNT)
        );
        const movedFrame = frame !== targetFrameRef.current;
        targetFrameRef.current = frame;
        if (frame !== drawnFrameRef.current) {
          if (drawFrame(frame)) drawnFrameRef.current = frame;
        }
        // Re-centre the load window on where the scroll actually is, and
        // fall back to the nearest loaded frame if this one hasn't landed
        // yet, so the hero keeps tracking the scroll instead of freezing.
        if (movedFrame) requestFrameWindowRef.current();
        syncCheckpoints(self.progress);
      },
    });

    // Paint the resting state so the first line is on screen before any scroll.
    syncCheckpoints(st.progress, true);

    // Mobile browsers fire "resize" repeatedly while scrolling, as the
    // URL bar shows and hides — coalesce bursts of those into one redraw
    // per frame instead of stacking up several full layout recomputes
    // during the same scroll gesture.
    let resizeHandle = 0;
    const onResize = () => {
      cancelAnimationFrame(resizeHandle);
      resizeHandle = requestAnimationFrame(() => {
        if (drawFrame(targetFrameRef.current)) {
          drawnFrameRef.current = targetFrameRef.current;
        } else {
          requestFrameWindowRef.current();
        }
      });
    };
    window.addEventListener("resize", onResize);

    return () => {
      st.kill();
      cancelAnimationFrame(resizeHandle);
      window.removeEventListener("resize", onResize);
    };
  }, [imagesReady, drawFrame]);

  // Cursor parallax: the cake tilts and drifts toward the pointer, so it
  // feels dimensional before you ever scroll. Mouse-like pointers only.
  useEffect(() => {
    const tilt = tiltRef.current;
    if (!tilt) return;
    if (typeof window.matchMedia !== "function") return;
    const finePointer = window.matchMedia("(pointer: fine)").matches;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!finePointer || reducedMotion) return;

    gsap.set(tilt, { transformPerspective: 1400, transformOrigin: "50% 50%" });

    const opts = { duration: 0.9, ease: "power3.out" } as const;
    const toRotateY = gsap.quickTo(tilt, "rotationY", opts);
    const toRotateX = gsap.quickTo(tilt, "rotationX", opts);
    const toX = gsap.quickTo(tilt, "x", opts);
    const toY = gsap.quickTo(tilt, "y", opts);

    const onPointerMove = (e: PointerEvent) => {
      const nx = (e.clientX / window.innerWidth - 0.5) * 2; // -1..1
      const ny = (e.clientY / window.innerHeight - 0.5) * 2;
      toRotateY(nx * 7);
      toRotateX(-ny * 5);
      toX(nx * 26);
      toY(ny * 16);
    };

    const onPointerLeave = () => {
      toRotateY(0);
      toRotateX(0);
      toX(0);
      toY(0);
    };

    window.addEventListener("pointermove", onPointerMove, { passive: true });
    document.addEventListener("pointerleave", onPointerLeave);

    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      document.removeEventListener("pointerleave", onPointerLeave);
      gsap.killTweensOf(tilt);
    };
  }, []);

  return (
    <div
      ref={wrapperRef}
      className="relative h-screen w-full overflow-hidden bg-[radial-gradient(115%_95%_at_50%_18%,#fdfaf5_0%,#f7f0e5_45%,#ece1d2_100%)]"
    >
      {/* Display type sits behind the cake — the overlap is what reads as
          depth. This cake is wide, so the line clears the cake at rest and
          the rising slice sweeps in front of it mid-scroll instead. */}
      <div className="absolute inset-x-0 top-[19%] z-0 flex justify-center px-6">
        <div className="relative w-full max-w-5xl text-center">
          {hero.checkpoints.map((cp, i) => (
            <h1
              key={i}
              data-checkpoint={i}
              className="absolute inset-x-0 top-0 font-display text-5xl font-semibold leading-[1.02] tracking-tight text-cocoa sm:text-7xl lg:text-8xl"
            >
              {cp.heading}
            </h1>
          ))}
        </div>
      </div>

      {/* The cake sequence, tilting with the pointer. */}
      <div
        ref={tiltRef}
        className="pointer-events-none absolute inset-0 z-10 will-change-transform"
        style={{ transformStyle: "preserve-3d" }}
      >
        <canvas
          ref={canvasRef}
          className="h-full w-full drop-shadow-[0_30px_50px_rgba(58,35,24,0.22)]"
        />
      </div>

      {!imagesReady && (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-cream">
          <div className="flex flex-col items-center gap-3 text-cocoa-light">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-cocoa/20 border-t-cocoa" />
            <span className="text-sm tracking-wide">Loading the cake…</span>
          </div>
        </div>
      )}

      <p className="absolute left-6 top-24 z-20 text-xs uppercase tracking-[0.3em] text-cocoa-light sm:left-10">
        {hero.eyebrow}
      </p>

      {/* Supporting line and CTA hug the bottom-left corner, clear of the
          centre column where the cake sits and the slice travels. */}
      <div className="absolute inset-x-6 top-[19%] z-20 mt-36 flex flex-col items-center gap-4 text-center sm:inset-x-auto sm:top-auto sm:bottom-10 sm:left-10 sm:mt-0 sm:w-88 sm:items-start sm:text-left">
        <div className="relative h-16 w-full">
          {hero.checkpoints.map((cp, i) =>
            cp.body ? (
              <p
                key={i}
                data-checkpoint={i}
                className="absolute inset-0 text-sm leading-relaxed text-cocoa-light"
              >
                {cp.body}
              </p>
            ) : null
          )}
        </div>
        <a
          href={hero.ctaHref}
          onClick={(e) => {
            if (!hero.ctaHref.startsWith("#")) return;
            const target = document.querySelector(hero.ctaHref);
            if (!target) return;
            e.preventDefault();
            target.scrollIntoView({ behavior: "smooth", block: "start" });
          }}
          className="rounded-full bg-cocoa px-6 py-3 text-sm font-medium text-cream transition hover:bg-cocoa-light"
        >
          {hero.ctaLabel}
        </a>
      </div>

      <span className="absolute bottom-10 right-6 z-20 hidden text-xs uppercase tracking-[0.3em] text-cocoa-light/70 sm:right-10 sm:block">
        Scroll
      </span>
    </div>
  );
}
