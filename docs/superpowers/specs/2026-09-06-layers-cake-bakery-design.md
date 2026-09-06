# Layers Cake Bakery — Scroll Sequence Website

Date: 2026-09-06
Status: Approved

## Goal
Build a marketing website for "Layers Cake Bakery" whose hero section uses a
scroll-scrubbed image-sequence animation (not video playback, not WebGL/3D)
to create a sense of depth, modeled on https://remix-of-cccc.vercel.app/.

## Reference
- Visual/interaction reference: https://remix-of-cccc.vercel.app/ (cookie
  brand site, sticky nav, hero scroll reveals, product grid, process
  timeline, values section, locations/newsletter footer).
- Source footage: `source-media/cake-sequence-source.mp4` — 1920x1080,
  24fps, 10s, 240 frames (H.264), generated via Google Flow per the user.

## Mechanism
1. At build time, extract 150 evenly-sampled frames from the source video
   via ffmpeg (`ffmpeg-static`/`ffprobe-static` npm packages, no system
   ffmpeg dependency), resized to ~1280px wide, encoded as WebP
   (~q75), written to `public/frames/frame-XXX.webp`.
2. A pinned full-viewport hero section renders a `<canvas>`. GSAP
   `ScrollTrigger` (scrub mode) maps scroll progress within the pinned
   section (0–1) to a frame index (0–149) and draws that frame to canvas
   on each scroll tick — no video element, no 3D engine.
3. Text callouts are absolutely positioned over the canvas and fade
   in/out at scroll-progress checkpoints (GSAP timeline tied to the same
   ScrollTrigger).
4. Frames are preloaded: first ~20 eagerly before the pin can start
   (with a lightweight loading state gating scroll), remainder streamed
   in the background.
5. Mobile: canvas draws at a capped resolution/DPR to protect
   performance; same frame set is reused (no separate mobile sequence).

## Page Structure
- Sticky nav — Menu, Story, Process, Locations, Order (anchor links)
- Hero — pinned scroll-scrubbed cake sequence + text reveals + CTA
- Menu — cake flavor grid, placeholder names/prices/images
- Process — 4-step timeline (bake steps), rhythm modeled on reference site
- Story/Values — bakery narrative + ingredients-in/out contrast section
- Locations + newsletter signup footer

## Content & Branding
Placeholder content (swappable later): warm bakery palette (cream/
chocolate/blush), serif+sans type pairing, invented flavors/prices/copy.
All content centralized in a single content/config module
(`src/content/site.ts`) rather than scattered across components, so a
non-developer edit pass later is a find-and-replace in one file.

## Tech Stack
- Next.js (App Router, TypeScript) + Tailwind CSS
- GSAP + ScrollTrigger for the scroll-scrub mechanism
- ffmpeg-static/ffprobe-static (dev-time only) for frame extraction
- Deployed as a standard Next.js app (Vercel-compatible)

## Out of Scope
- Real checkout/payments (CTAs are placeholder "Order" links)
- CMS integration
- Real brand assets/photography beyond the extracted cake frames
