"use client";

import { useEffect, useRef, useState } from "react";
import gsap from "gsap";
import ScrollTrigger from "gsap/ScrollTrigger";
import { hero } from "@/content/site";

const FRAME_COUNT = 150;
const EAGER_FRAME_COUNT = 20;
const PIN_HEIGHT_VH = 350; // scroll distance the sequence plays across

function frameUrl(index: number) {
  const n = String(index + 1).padStart(3, "0");
  return `/frames/frame-${n}.webp`;
}

export default function ScrollCakeHero() {
  const wrapperRef = useRef<HTMLDivElement>(null);
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

      for (let i = EAGER_FRAME_COUNT; i < FRAME_COUNT; i++) {
        if (cancelled) return;
        await loadFrame(i);
      }
    }

    run();
    return () => {
      cancelled = true;
    };
  }, []);

  // Draw current frame to canvas, fit to cover the canvas box.
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

    const imgRatio = img.naturalWidth / img.naturalHeight;
    const boxRatio = cssWidth / cssHeight;
    let drawWidth: number;
    let drawHeight: number;
    if (imgRatio > boxRatio) {
      drawHeight = cssHeight;
      drawWidth = drawHeight * imgRatio;
    } else {
      drawWidth = cssWidth;
      drawHeight = drawWidth / imgRatio;
    }
    const dx = (cssWidth - drawWidth) / 2;
    const dy = (cssHeight - drawHeight) / 2;
    ctx.drawImage(img, dx, dy, drawWidth, drawHeight);
  };

  useEffect(() => {
    if (!imagesReady) return;
    gsap.registerPlugin(ScrollTrigger);

    drawFrame(0);

    const wrapper = wrapperRef.current;
    if (!wrapper) return;

    const checkpointEls = hero.checkpoints.map((_, i) =>
      wrapper.querySelector<HTMLElement>(`[data-checkpoint="${i}"]`)
    );
    gsap.set(checkpointEls.filter(Boolean) as HTMLElement[], { opacity: 0, y: 16 });

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

        hero.checkpoints.forEach((cp, i) => {
          const el = checkpointEls[i];
          if (!el) return;
          const next = hero.checkpoints[i + 1]?.progress ?? 1;
          const inRange =
            self.progress >= cp.progress && self.progress < next - 0.02;
          const targetOpacity = inRange ? 1 : 0;
          if (Number(el.dataset.targetOpacity) !== targetOpacity) {
            el.dataset.targetOpacity = String(targetOpacity);
            gsap.to(el, {
              opacity: targetOpacity,
              y: inRange ? 0 : 16,
              duration: 0.3,
              overwrite: "auto",
            });
          }
        });
      },
    });

    const onResize = () => drawFrame(currentFrameRef.current);
    window.addEventListener("resize", onResize);

    return () => {
      st.kill();
      window.removeEventListener("resize", onResize);
    };
  }, [imagesReady]);

  return (
    <div ref={wrapperRef} className="relative h-screen w-full overflow-hidden bg-cocoa">
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />

      {!imagesReady && (
        <div className="absolute inset-0 flex items-center justify-center bg-cocoa">
          <div className="flex flex-col items-center gap-3 text-cream/80">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-cream/30 border-t-cream" />
            <span className="text-sm tracking-wide">Loading the cake…</span>
          </div>
        </div>
      )}

      <div className="pointer-events-none absolute inset-0 bg-linear-to-b from-cocoa/40 via-transparent to-cocoa/60" />

      <p className="absolute left-1/2 top-24 -translate-x-1/2 text-xs uppercase tracking-[0.3em] text-cream/70">
        {hero.eyebrow}
      </p>

      <div className="absolute inset-0 flex items-end justify-center pb-24 sm:items-center sm:pb-0">
        <div className="relative h-40 w-[min(90vw,640px)] text-center sm:h-48">
          {hero.checkpoints.map((cp, i) => (
            <div
              key={i}
              data-checkpoint={i}
              className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-4"
            >
              <h1 className="font-display text-3xl font-medium text-cream sm:text-5xl">
                {cp.heading}
              </h1>
              {cp.body && (
                <p className="max-w-md text-sm text-cream/80 sm:text-base">{cp.body}</p>
              )}
            </div>
          ))}
        </div>
      </div>

      <a
        href={hero.ctaHref}
        className="absolute bottom-8 left-1/2 -translate-x-1/2 rounded-full bg-cream px-6 py-3 text-sm font-medium text-cocoa transition hover:bg-blush"
      >
        {hero.ctaLabel}
      </a>
    </div>
  );
}
