"use client";

import { useEffect, useRef, useState } from "react";
import gsap from "gsap";
import ScrollTrigger from "gsap/ScrollTrigger";
import { hero } from "@/content/site";

const FRAME_COUNT = 150;
// Only the frames actually needed to paint the resting hero are gated on.
// Each frame is ~30KB and cold TTFB runs ~0.6s, so waiting on a big batch
// left "Loading the cake…" on screen for several seconds; the rest stream
// in behind the visible hero instead.
const EAGER_FRAME_COUNT = 2;
// How many of the remaining frames to fetch at once. Enough to stay ahead
// of a scroll, few enough not to saturate the connection.
const PRELOAD_CONCURRENCY = 8;
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
const PORTRAIT_WIDTH_FACTOR = 3;
const PORTRAIT_MAX_HEIGHT = 0.85;
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

export default function ScrollCakeHero() {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const tiltRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imagesRef = useRef<HTMLImageElement[]>([]);
  const currentFrameRef = useRef(0);
  const [imagesReady, setImagesReady] = useState(false);

  // Preload frames: first N eagerly (gate on these), rest in background.
  useEffect(() => {
    let cancelled = false;
    const images: HTMLImageElement[] = new Array(FRAME_COUNT);

    const loadFrame = (i: number) =>
      new Promise<void>((resolve) => {
        const img = new Image();
        img.src = frameUrl(i);
        img.onload = () => resolve();
        img.onerror = () => resolve();
        images[i] = img;
      });

    async function run() {
      const eager = Array.from({ length: EAGER_FRAME_COUNT }, (_, i) => loadFrame(i));
      await Promise.all(eager);
      if (cancelled) return;
      imagesRef.current = images;
      setImagesReady(true);

      // Stream the rest in order, a few at a time. Frames that haven't
      // arrived yet are simply skipped by drawFrame, which holds the last
      // painted frame rather than blanking the canvas.
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
    };
  }, []);

  // Draw the current frame: contained, centered, scaled down, edges feathered.
  const drawFrame = (index: number) => {
    const canvas = canvasRef.current;
    const img = imagesRef.current[index];
    if (!canvas || !img || !img.complete || img.naturalWidth === 0) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cssWidth = canvas.clientWidth;
    const cssHeight = canvas.clientHeight;
    if (canvas.width !== cssWidth * dpr || canvas.height !== cssHeight * dpr) {
      canvas.width = cssWidth * dpr;
      canvas.height = cssHeight * dpr;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssWidth, cssHeight);

    // Landscape: contain the whole frame, then scale down so the cake floats
    // with breathing room. Portrait: size by width so the cake stays large.
    let scale;
    if (cssHeight > cssWidth) {
      scale = (cssWidth * PORTRAIT_WIDTH_FACTOR) / img.naturalWidth;
      const maxHeight = cssHeight * PORTRAIT_MAX_HEIGHT;
      if (img.naturalHeight * scale > maxHeight) {
        scale = maxHeight / img.naturalHeight;
      }
    } else {
      scale =
        Math.min(cssWidth / img.naturalWidth, cssHeight / img.naturalHeight) * FIT_SCALE;
    }

    const drawWidth = img.naturalWidth * scale;
    const drawHeight = img.naturalHeight * scale;
    // Anchored to the bottom, not centred: the cake stays grounded on the
    // page, and where the camera crops its base the crop falls off screen.
    const dx = (cssWidth - drawWidth) / 2;
    const dy = cssHeight - drawHeight + drawHeight * BOTTOM_OVERSHOOT;
    ctx.drawImage(img, dx, dy, drawWidth, drawHeight);

    // Dissolve anything the camera cropped at the frame's edges.
    const right = dx + drawWidth;
    const bottom = dy + drawHeight;
    const bands: Array<[number, number, number, number, number[], number[]]> = [
      // [x, y, w, h, gradient start point, gradient end point]
      [dx, dy, drawWidth, drawHeight * EDGE_FADE.top, [0, dy + drawHeight * EDGE_FADE.top], [0, dy]],
      [dx, bottom - drawHeight * EDGE_FADE.bottom, drawWidth, drawHeight * EDGE_FADE.bottom,
        [0, bottom - drawHeight * EDGE_FADE.bottom], [0, bottom]],
      [dx, dy, drawWidth * EDGE_FADE.left, drawHeight, [dx + drawWidth * EDGE_FADE.left, 0], [dx, 0]],
      [right - drawWidth * EDGE_FADE.right, dy, drawWidth * EDGE_FADE.right, drawHeight,
        [right - drawWidth * EDGE_FADE.right, 0], [right, 0]],
    ];

    ctx.save();
    ctx.globalCompositeOperation = "destination-out";
    for (const [bx, by, bw, bh, from, to] of bands) {
      const fade = ctx.createLinearGradient(from[0], from[1], to[0], to[1]);
      fade.addColorStop(0, "rgba(0,0,0,0)");
      fade.addColorStop(1, "rgba(0,0,0,1)");
      ctx.fillStyle = fade;
      ctx.fillRect(bx, by, bw, bh);
    }
    ctx.restore();
  };

  // Scroll-driven frame scrub + checkpoint text reveals.
  useEffect(() => {
    if (!imagesReady) return;
    gsap.registerPlugin(ScrollTrigger);

    drawFrame(0);

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
        const frame = Math.min(
          FRAME_COUNT - 1,
          Math.floor(self.progress * FRAME_COUNT)
        );
        if (frame !== currentFrameRef.current) {
          currentFrameRef.current = frame;
        }
        drawFrame(frame);
        syncCheckpoints(self.progress);
      },
    });

    // Paint the resting state so the first line is on screen before any scroll.
    syncCheckpoints(st.progress, true);

    const onResize = () => drawFrame(currentFrameRef.current);
    window.addEventListener("resize", onResize);

    return () => {
      st.kill();
      window.removeEventListener("resize", onResize);
    };
  }, [imagesReady]);

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
