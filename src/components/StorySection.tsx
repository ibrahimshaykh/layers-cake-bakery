import { values } from "@/content/site";

export default function StorySection() {
  return (
    <section id="story" className="mx-auto max-w-6xl px-6 py-24">
      <div className="grid gap-12 lg:grid-cols-2 lg:items-center">
        <div>
          <p className="text-xs uppercase tracking-[0.3em] text-caramel">Our story</p>
          <h2 className="mt-3 font-display text-4xl font-medium text-cocoa sm:text-5xl">
            {values.heading}
          </h2>
          <p className="mt-4 text-cocoa-light">
            We started Layers because most &ldquo;fresh&rdquo; cake isn&apos;t fresh at
            all — it&apos;s frozen, thawed, and dressed up. Ours is mixed, baked, and
            layered by hand every single day, with nothing hiding in the ingredient list.
          </p>
        </div>

        <div className="grid gap-6 sm:grid-cols-2">
          <div className="rounded-2xl border border-cocoa/10 bg-white/60 p-6">
            <h3 className="font-display text-lg font-medium text-cocoa">What we use</h3>
            <ul className="mt-4 space-y-2 text-sm text-cocoa-light">
              {values.weUse.map((item) => (
                <li key={item} className="flex items-center gap-2">
                  <span className="h-1.5 w-1.5 rounded-full bg-caramel" />
                  {item}
                </li>
              ))}
            </ul>
          </div>
          <div className="rounded-2xl border border-cocoa/10 bg-white/60 p-6">
            <h3 className="font-display text-lg font-medium text-cocoa">What we leave out</h3>
            <ul className="mt-4 space-y-2 text-sm text-cocoa-light">
              {values.weAvoid.map((item) => (
                <li key={item} className="flex items-center gap-2">
                  <span className="h-1.5 w-1.5 rounded-full bg-blush-dark" />
                  {item}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </section>
  );
}
