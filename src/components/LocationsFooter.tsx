"use client";

import { brand, footer, locations } from "@/content/site";

export default function LocationsFooter() {
  return (
    <footer id="locations" className="bg-cocoa text-cream">
      <div className="mx-auto max-w-6xl px-6 py-20">
        <div className="grid gap-14 lg:grid-cols-2">
          <div>
            <p className="text-xs uppercase tracking-[0.3em] text-blush">Visit us</p>
            <div className="mt-6 grid gap-8 sm:grid-cols-2">
              {locations.map((loc) => (
                <div key={loc.name}>
                  <h3 className="font-display text-lg font-medium">{loc.name}</h3>
                  <p className="mt-2 text-sm text-cream/70">{loc.address}</p>
                  <p className="mt-1 text-sm text-cream/50">{loc.hours}</p>
                </div>
              ))}
            </div>
          </div>

          <div>
            <p className="text-xs uppercase tracking-[0.3em] text-blush">Stay in the loop</p>
            <h3 className="mt-3 font-display text-2xl font-medium">
              {footer.newsletterHeading}
            </h3>
            <p className="mt-2 text-sm text-cream/70">{footer.newsletterSub}</p>
            <form
              className="mt-6 flex max-w-sm gap-2"
              onSubmit={(e) => e.preventDefault()}
            >
              <input
                type="email"
                required
                placeholder="you@email.com"
                className="w-full rounded-full border border-cream/20 bg-transparent px-4 py-2 text-sm text-cream placeholder:text-cream/40 focus:border-cream/50 focus:outline-none"
              />
              <button
                type="submit"
                className="shrink-0 rounded-full bg-cream px-5 py-2 text-sm font-medium text-cocoa transition hover:bg-blush"
              >
                Sign up
              </button>
            </form>
          </div>
        </div>

        <div className="mt-16 flex flex-col items-center justify-between gap-4 border-t border-cream/10 pt-8 text-sm text-cream/50 sm:flex-row">
          <span>
            © {new Date().getFullYear()} {brand.fullName}
          </span>
          <span>Made fresh, every day.</span>
        </div>
      </div>
    </footer>
  );
}
