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
1. At build time, `scripts/extract-frames.mjs` turns the source video into
   150 transparent WebP frames in `public/frames/` (ffmpeg-static, no
   system ffmpeg dependency). Two things it works around:
   - **Framing.** The full 10s take is used, so the scroll plays the whole
     video through — this was an explicit client requirement. Note the
     camera pushes in throughout: past ~4.5s the cake's base leaves the
     bottom of the frame, and the take ends on the slice bursting apart
     rather than landing. That content was never filmed and cannot be
     recovered in code; the hero counter-zooms and bottom-anchors to keep
     the crop off screen (see 3). Getting a true "slice lands on the whole
     cake" beat needs re-shot footage with a wider, locked-off framing.
   - **Background.** The subject sits on a bright studio sweep. Each frame
     gets a difference matte: rebuild the sweep behind the subject (coarse
     grid + Laplace inpainting), then derive alpha from each pixel's
     departure from that plate. Keeps highlights and the soft contact
     shadow, which a luma key destroys. Measured separation on this
     footage: subject at luma 28-140, sweep at 214-244.
2. A pinned full-viewport hero section renders a `<canvas>`. GSAP
   `ScrollTrigger` (scrub mode) maps scroll progress within the pinned
   section (0–1) to a frame index (0–149) and draws that frame to canvas
   on each scroll tick — no video element, no 3D engine.
3. Sizing and placement:
   - Contain-fit and scaled down, so the cake is never cropped by us.
     Portrait screens size by width instead, or the subject — which only
     fills the middle of a 16:9 frame — would shrink to a speck.
   - Anchored to the bottom of the viewport (slightly past it), not
     centred. This is what stops the camera's crop from reading as a
     half-drawn cake floating in mid-air: it simply runs off screen, the
     way any full-bleed hero image does.
   - A counter-zoom draws later frames progressively smaller, cancelling
     most of the source's push-in so the cake holds a steady size.
   - Top and side edges feather, so flying chocolate cropped by the camera
     dissolves instead of ending in a straight cut. The bottom needs no
     fade because of the anchoring above.
4. Display type sits *behind* the canvas; the cake overlapping it is what
   reads as depth. Headings are short and ride above the cake, because
   this cake is wide where the reference's cookie stack is narrow — a long
   centred line would be unreadable behind it. The rising slice sweeps in
   front of the type mid-scroll instead. Supporting copy and the CTA sit
   bottom-left on desktop, and move up under the headline on phones where
   the cake fills the lower half. Callouts fade in/out at scroll-progress
   checkpoints, driven from the same ScrollTrigger's `onUpdate`.
5. Cursor parallax: the cake tilts and drifts toward the pointer (GSAP
   `quickTo` on rotationX/Y and x/y), so it feels dimensional before the
   user scrolls at all. Fine pointers only, and off under
   `prefers-reduced-motion`. Note: the reference site does *not* do this —
   verified by diffing its DOM under pointer movement — it was added
   because the client asked for it.
6. Frames are preloaded: first ~20 eagerly before the pin can start
   (with a lightweight loading state gating scroll), remainder streamed
   in the background.
7. Mobile: canvas draws at a capped resolution/DPR to protect
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
