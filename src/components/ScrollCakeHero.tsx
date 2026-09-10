"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import gsap from "gsap";
import ScrollTrigger from "gsap/ScrollTrigger";
import { hero } from "@/content/site";

const FRAME_COUNT = 150;
// Windowed loading (see the preload effect for the full reasoning). These
// bound how much decoded bitmap is resident at once: roughly
// (AHEAD + BEHIND + 2*MARGIN) frames, each costing width*height*4 bytes.
// Hence a profile per set — a resident frame costs 5.8MB at 1600x900 and
// 2.1MB at 960x540, so the phone can't hold as many of them.
//   desktop: ~32 frames * 5.8MB ~= 185MB
//   mobile:  ~27 frames * 2.1MB ~=  56MB
// MARGIN is hysteresis, so frames right at the window edge aren't
// released and re-fetched repeatedly as the scroll jitters back and forth.
const WINDOW_DESKTOP = { ahead: 14, behind: 6, margin: 6 };
const WINDOW_MOBILE = { ahead: 12, behind: 5, margin: 5 };
const MAX_CONCURRENT_LOADS = 6;
// How far from the wanted frame to look for an already-loaded one to show
// instead, when the scroll has outrun loading.
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

  // Frame loading is windowed, not "load all 150 and keep them".
  //
  // Holding the whole sequence resident costs width*height*4 bytes of
  // decoded bitmap per frame — ~527MB at 1280x720, or ~132MB even at the
  // phone size. A desktop absorbs that invisibly, which is exactly why
  // every desktop test of this looked perfect. A phone can't: iOS Safari
  // has a hard per-tab memory ceiling well under it, so it evicts frames
  // and then has to re-decode them mid-scroll, which is what made the
  // animation stall on a real device.
  //
  // So instead: keep a window of frames around wherever the scroll is,
  // load toward it (nearest-first, so the frame actually being shown wins
  // the race), and release what's far outside it. Released frames come
  // back from the HTTP cache rather than the network, so scrolling back
  // costs a decode, not a download. Memory stays bounded no matter how
  // long the sequence is.
  useEffect(() => {
    let cancelled = false;
    const frames: Array<FrameSource | undefined> = new Array(FRAME_COUNT);
    // 0 = not loaded, 1 = in flight, 2 = ready
    const state = new Uint8Array(FRAME_COUNT);
    let inFlight = 0;

    const release = (i: number) => {
      // In-flight loads are deliberately left to finish rather than
      // aborted when the window moves off them. Cancelling them was tried
      // and is much worse: during a continuous scroll the window moves
      // faster than a frame can arrive, so essentially every load got
      // cancelled just before completing and the sequence showed 7 frames
      // instead of ~50. A frame that lands late still feeds the
      // nearest-available fallback.
      if (state[i] !== 2) return;
      const frame = frames[i];
      // close() frees the decoded pixels immediately and deterministically.
      if (frame && "close" in frame) frame.close();
      frames[i] = undefined;
      state[i] = 0;
    };

    const startLoad = (i: number) => {
      if (cancelled || state[i] !== 0) return;
      state[i] = 1;
      inFlight++;
      let settled = false;
      const settle = () => {
        if (settled) return false;
        settled = true;
        inFlight--;
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
        // The resting frame is all the hero waits on before revealing.
        if (i === 0) setImagesReady(true);
        // Repaint if this arrival is a better match for where the scroll
        // is now than whatever is currently on the canvas.
        paintBestAvailable();
        pump();
      };
      const fail = () => {
        if (!settle()) return;
        if (state[i] === 1) state[i] = 0;
        if (cancelled) return;
        // Frame 0 gates the reveal, so a blip there can't be left alone or
        // the hero sits behind its loading state indefinitely.
        if (i === 0) window.setTimeout(() => !cancelled && startLoad(0), 500);
        pump();
      };

      // Fetch + createImageBitmap rather than an <img>.
      //
      // These sources are never attached to the document, and Chromium is
      // free to throw away the decoded pixels of an unattached image — so
      // every drawImage paid a fresh WebP-with-alpha decode on the main
      // thread. Measured: stubbing out the draw dropped p90 frame time
      // from 131ms to 19ms under 4x CPU throttle, while shrinking the
      // canvas barely moved it, which put the cost squarely on the source
      // side. An ImageBitmap is decoded once, off the main thread, and
      // stays decoded until closed.
      if (typeof createImageBitmap === "function") {
        fetch(frameUrl(i))
          .then((res) => (res.ok ? res.blob() : Promise.reject(new Error(String(res.status)))))
          .then((blob) => createImageBitmap(blob))
          .then(succeed)
          .catch(fail);
        return;
      }

      const img = new Image();
      img.src = frameUrl(i);
      img.onload = () => {
        if (img.decode) img.decode().catch(() => {}).finally(() => succeed(img));
        else succeed(img);
      };
      img.onerror = fail;
    };

    // Draw the closest frame to the target that's actually loaded.
    //
    // On a slow connection the scroll routinely outruns loading — 150
    // frames can't all arrive during a few seconds of scrolling. Drawing
    // only on an exact hit means the hero freezes on whichever frame last
    // landed, which is exactly what "stuck" looked like. Showing the
    // nearest available frame instead keeps the cake tracking the scroll,
    // just at coarser granularity, and it sharpens up as frames arrive.
    function paintBestAvailable() {
      if (cancelled) return;
      const target = targetFrameRef.current;
      const drawn = drawnFrameRef.current;
      // Don't let the substitute frame run against the scroll: while
      // scrolling forward, only consider frames at or ahead of what's
      // already shown (and vice versa). Otherwise a gap in what's loaded
      // makes the cake visibly jump backwards mid-scroll.
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

    // Keep the window around the current target filled and drop the rest.
    // Nearest-first ordering matters more than raw throughput here: on a
    // fast flick the target moves constantly, and what must win is the
    // frame currently on screen, not the 40 the scroll already passed.
    function pump() {
      if (cancelled) return;
      const target = targetFrameRef.current;
      const win = frameWindow();

      const keepLo = Math.max(0, target - win.behind - win.margin);
      const keepHi = Math.min(FRAME_COUNT - 1, target + win.ahead + win.margin);
      for (let i = 0; i < FRAME_COUNT; i++) {
        if (i < keepLo || i > keepHi) release(i);
      }

      // Nearest-first, and always inside the concurrency cap — including
      // for the target itself. Letting the target bypass the cap was
      // tried: because pump() runs on every frame change, it spawned a
      // fresh request per change and saturated a slow link, which cut the
      // sequence from ~50 frames to ~20. The cap is what keeps the
      // connection usable, so the target's priority comes from being
      // first in this ordering, not from being exempt.
      for (let d = 0; d <= win.ahead; d++) {
        if (inFlight >= MAX_CONCURRENT_LOADS) return;
        const ahead = target + d;
        if (ahead < FRAME_COUNT) startLoad(ahead);
        if (d === 0) continue;
        if (inFlight >= MAX_CONCURRENT_LOADS) return;
        const behind = target - d;
        if (d <= win.behind && behind >= 0) startLoad(behind);
      }
    }

    requestFrameWindowRef.current = () => {
      paintBestAvailable();
      pump();
    };

    framesRef.current = frames;
    // Gate the hero on just the resting frame, then let the window fill in
    // behind it (startLoad's finish() flips imagesReady and pumps).
    startLoad(0);

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
      scrub: 0.4,
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
