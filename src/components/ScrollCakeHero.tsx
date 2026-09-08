"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import gsap from "gsap";
import ScrollTrigger from "gsap/ScrollTrigger";
import { hero } from "@/content/site";

const FRAME_COUNT = 150;
// Only the frames actually needed to paint the resting hero are gated on.
// Each frame is ~30KB and cold TTFB runs ~0.6s, so waiting on a big batch
// left "Loading the cake…" on screen for several seconds; the rest stream
// in behind the visible hero instead.
const EAGER_FRAME_COUNT = 2;
// How many of the remaining frames to fetch at once in the background
// queue. A fast scroll outrunning this is expected and handled — see
// ensureFrameLoadingRef — so this only has to be reasonable, not perfect.
const PRELOAD_CONCURRENCY = 12;
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
// Flying chocolate gets cropped at the top and sides late in the take.
// Without a backdrop to sit in, those crops would read as hard straight
// cuts, so those edges dissolve. The bottom needs no fade: the frame is
// anchored past the bottom of the viewport (see BOTTOM_OVERSHOOT), so the
// cake's cropped base runs off screen rather than ending in mid-air.
const EDGE_FADE = { top: 0.06, bottom: 0, left: 0.05, right: 0.05 };
// How far below the viewport's bottom edge the frame is anchored, as a
// fraction of the drawn frame height.
const BOTTOM_OVERSHOOT = 0.04;
// No counter-zoom: the source's own push-in is what makes the cake fill
// more of the screen as you scroll, base and all, the same way it plays in
// the original video. An earlier version shrank later frames to keep the
// subject a "steady size", but that also shrank the base out of view well
// before the camera actually cropped it — undoing the exact moment the
// push-in is meant to deliver.

function frameUrl(index: number) {
  const n = String(index + 1).padStart(3, "0");
  return `/frames/frame-${n}.webp`;
}

// Every extracted frame is decoded at this fixed size (see
// scripts/extract-frames.mjs), so layout math never needs to touch an
// actual <img> — it's the same for frame 1 and frame 150.
const NATIVE_WIDTH = 1280;
const NATIVE_HEIGHT = 720;

type Layout = {
  dx: number;
  dy: number;
  drawWidth: number;
  drawHeight: number;
  // Precomputed destination-out gradient fills for the edge dissolve.
  // Position/size never change between frames at a given canvas size, so
  // these are built once per resize instead of once per scroll tick.
  bands: Array<{ x: number; y: number; w: number; h: number; gradient: CanvasGradient }>;
};

function computeLayout(ctx: CanvasRenderingContext2D, cssWidth: number, cssHeight: number): Layout {
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
  const right = dx + drawWidth;
  const bottom = dy + drawHeight;

  const makeBand = (
    x: number,
    y: number,
    w: number,
    h: number,
    from: [number, number],
    to: [number, number]
  ) => {
    const gradient = ctx.createLinearGradient(from[0], from[1], to[0], to[1]);
    gradient.addColorStop(0, "rgba(0,0,0,0)");
    gradient.addColorStop(1, "rgba(0,0,0,1)");
    return { x, y, w, h, gradient };
  };

  const bands = [
    makeBand(dx, dy, drawWidth, drawHeight * EDGE_FADE.top, [0, dy + drawHeight * EDGE_FADE.top], [0, dy]),
    makeBand(
      dx,
      bottom - drawHeight * EDGE_FADE.bottom,
      drawWidth,
      drawHeight * EDGE_FADE.bottom,
      [0, bottom - drawHeight * EDGE_FADE.bottom],
      [0, bottom]
    ),
    makeBand(dx, dy, drawWidth * EDGE_FADE.left, drawHeight, [dx + drawWidth * EDGE_FADE.left, 0], [dx, 0]),
    makeBand(
      right - drawWidth * EDGE_FADE.right,
      dy,
      drawWidth * EDGE_FADE.right,
      drawHeight,
      [right - drawWidth * EDGE_FADE.right, 0],
      [right, 0]
    ),
  ];

  return { dx, dy, drawWidth, drawHeight, bands };
}

export default function ScrollCakeHero() {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const tiltRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imagesRef = useRef<HTMLImageElement[]>([]);
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
  // Priority-loads a specific frame immediately, ahead of the sequential
  // background queue. Set once the preload effect below has a real
  // implementation; see the comment there for why this exists.
  const ensureFrameLoadingRef = useRef<(index: number) => void>(() => {});
  const [imagesReady, setImagesReady] = useState(false);

  // Preload frames: first N eagerly (gate on these), rest streamed in order
  // behind the visible hero. Fast scrolling — a real phone flick easily
  // covers the whole sequence in under a second — can reach a frame long
  // before that ordered queue gets to it. Measured against the deployed
  // site: touch-scrolling straight through left the hero frozen on
  // whatever frame last finished loading for several seconds, well past
  // where the scroll itself had already gone, because nothing asked for
  // the actually-needed frame until the queue's linear crawl reached it.
  // ensureFrameLoading (below) is the fix: a frame the scroll wants but
  // doesn't have yet gets its own fetch immediately, independent of the
  // queue's position, so the worst case is one image's fetch+decode time
  // instead of "however long until the queue works through everything
  // before it".
  useEffect(() => {
    let cancelled = false;
    const images: HTMLImageElement[] = new Array(FRAME_COUNT);
    // One promise per index, however it got started (queue or priority),
    // so neither path ever double-fetches the same frame.
    const loadPromises: Array<Promise<void> | null> = new Array(FRAME_COUNT).fill(null);

    const loadFrame = (i: number): Promise<void> => {
      const existing = loadPromises[i];
      if (existing) return existing;
      const promise = new Promise<void>((resolve) => {
        const img = new Image();
        img.src = frameUrl(i);
        const done = () => {
          // Decode off the main thread so the first draw of this frame
          // doesn't stall on it — otherwise a scroll that reaches a
          // freshly-arrived frame can visibly hitch on decode.
          const finish = () => {
            // If the scroll is already sitting on this frame and it
            // couldn't paint earlier because this exact image wasn't
            // ready, paint it now instead of leaving the hero stuck on
            // whatever last successfully drew.
            if (i === targetFrameRef.current && drawnFrameRef.current !== i) {
              if (drawFrameRef.current(i)) drawnFrameRef.current = i;
            }
            resolve();
          };
          if (img.decode) img.decode().catch(() => {}).finally(finish);
          else finish();
        };
        img.onload = done;
        img.onerror = () => resolve();
        images[i] = img;
      });
      loadPromises[i] = promise;
      return promise;
    };

    // Single-flight priority fetch. A fast scroll can pass through dozens
    // of frame indices before any one of them finishes loading; naively
    // starting a separate priority fetch per index means all of them stay
    // in flight competing for the same (often slow, mobile) connection,
    // so the one actually needed once scrolling settles sits queued
    // behind a pile of ones nobody wants anymore. Instead there's only
    // ever one priority request outstanding, always for the most recent
    // target — an older one gets its src cleared (which cancels the
    // in-flight fetch in every major browser) the moment a newer target
    // supersedes it.
    let priorityImg: HTMLImageElement | null = null;
    let priorityTarget = -1;
    const priorityLoad = (i: number) => {
      if (loadPromises[i] || priorityTarget === i) return;
      if (priorityImg) priorityImg.src = "data:,"; // cancel the superseded fetch (not "" - that re-requests the page URL)
      priorityTarget = i;
      const img = new Image();
      priorityImg = img;
      img.src = frameUrl(i);
      const settle = () => {
        if (priorityTarget === i) priorityTarget = -1;
      };
      img.onload = () => {
        const finish = () => {
          if (cancelled || priorityTarget !== i) return; // superseded meanwhile
          images[i] = img;
          loadPromises[i] = Promise.resolve();
          if (i === targetFrameRef.current && drawnFrameRef.current !== i) {
            if (drawFrameRef.current(i)) drawnFrameRef.current = i;
          }
          settle();
        };
        if (img.decode) img.decode().catch(() => {}).finally(finish);
        else finish();
      };
      img.onerror = settle;
    };

    ensureFrameLoadingRef.current = (i: number) => {
      if (!cancelled) priorityLoad(i);
    };

    async function run() {
      const eager = Array.from({ length: EAGER_FRAME_COUNT }, (_, i) => loadFrame(i));
      await Promise.all(eager);
      if (cancelled) return;
      imagesRef.current = images;
      setImagesReady(true);

      // Background fill for the ordinary case of scrolling roughly in
      // order. Frames a fast scroll jumps ahead to are handled by the
      // priority path above instead of waiting for this to arrive.
      for (let i = EAGER_FRAME_COUNT; i < FRAME_COUNT; i += PRELOAD_CONCURRENCY) {
        if (cancelled) return;
        const batch = [];
        for (let j = i; j < Math.min(i + PRELOAD_CONCURRENCY, FRAME_COUNT); j++) {
          batch.push(loadFrame(j));
        }
        await Promise.all(batch);
      }
    }

    run();
    return () => {
      cancelled = true;
      if (priorityImg) priorityImg.src = "data:,";
    };
  }, []);

  // Layout (position/scale/edge-gradients) is identical for every frame at
  // a given canvas size — nothing here depends on which frame is showing —
  // so it's computed once per size change instead of once per scroll tick.
  const getLayout = useCallback(
    (ctx: CanvasRenderingContext2D, cssWidth: number, cssHeight: number, dpr: number) => {
      const cached = layoutRef.current;
      if (cached && cached.cssWidth === cssWidth && cached.cssHeight === cssHeight && cached.dpr === dpr) {
        return cached.layout;
      }
      const layout = computeLayout(ctx, cssWidth, cssHeight);
      layoutRef.current = { layout, cssWidth, cssHeight, dpr };
      return layout;
    },
    []
  );

  // Draw the current frame: contained, anchored to the bottom, edges
  // feathered. Only touches the canvas — no gradient allocation, no scale
  // math — so it's cheap enough to call on every scroll tick. Returns
  // whether it actually painted, so callers can tell "drew it" apart from
  // "this frame's image isn't ready yet" and retry later instead of
  // treating a skipped draw as done.
  const drawFrame = useCallback((index: number): boolean => {
    const canvas = canvasRef.current;
    const img = imagesRef.current[index];
    if (!canvas || !img || !img.complete || img.naturalWidth === 0) return false;

    const ctx = canvas.getContext("2d");
    if (!ctx) return false;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cssWidth = canvas.clientWidth;
    const cssHeight = canvas.clientHeight;
    if (canvas.width !== cssWidth * dpr || canvas.height !== cssHeight * dpr) {
      canvas.width = cssWidth * dpr;
      canvas.height = cssHeight * dpr;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssWidth, cssHeight);

    const { dx, dy, drawWidth, drawHeight, bands } = getLayout(ctx, cssWidth, cssHeight, dpr);
    ctx.drawImage(img, dx, dy, drawWidth, drawHeight);

    ctx.save();
    ctx.globalCompositeOperation = "destination-out";
    for (const band of bands) {
      ctx.fillStyle = band.gradient;
      ctx.fillRect(band.x, band.y, band.w, band.h);
    }
    ctx.restore();
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
        const next = hero.checkpoints[i + 1]?.progress ?? 1.02;
        const inRange = progress >= cp.progress && progress < next - 0.02;
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
        targetFrameRef.current = frame;
        if (frame !== drawnFrameRef.current) {
          if (drawFrame(frame)) {
            drawnFrameRef.current = frame;
          } else {
            // This frame's image isn't loaded yet. Fetch it directly
            // instead of waiting for the background queue to reach it —
            // on a fast scroll that queue could be 100+ frames behind.
            ensureFrameLoadingRef.current(frame);
          }
        }
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
          ensureFrameLoadingRef.current(targetFrameRef.current);
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
