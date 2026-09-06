import { flavors } from "@/content/site";

export default function MenuSection() {
  return (
    <section id="menu" className="mx-auto max-w-6xl px-6 py-24">
      <div className="mb-12 max-w-xl">
        <p className="text-xs uppercase tracking-[0.3em] text-caramel">The menu</p>
        <h2 className="mt-3 font-display text-4xl font-medium text-cocoa sm:text-5xl">
          Six layers, always.
        </h2>
        <p className="mt-4 text-cocoa-light">
          Every cake we make is built the same way — layer, cream, layer — just with
          different flavors in between.
        </p>
      </div>

      <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
        {flavors.map((flavor) => (
          <article
            key={flavor.id}
            className="group flex flex-col justify-between rounded-2xl border border-cocoa/10 bg-white/60 p-6 transition hover:border-cocoa/20 hover:shadow-md"
          >
            <div>
              <div className="mb-3 flex items-start justify-between gap-3">
                <h3 className="font-display text-xl font-medium text-cocoa">
                  {flavor.name}
                </h3>
                {flavor.tag && (
                  <span className="shrink-0 rounded-full bg-blush/40 px-3 py-1 text-xs font-medium text-cocoa">
                    {flavor.tag}
                  </span>
                )}
              </div>
              <p className="text-sm text-cocoa-light">{flavor.description}</p>
            </div>
            <div className="mt-6 flex items-center justify-between">
              <span className="font-display text-lg text-cocoa">{flavor.price}</span>
              <button className="rounded-full border border-cocoa/20 px-4 py-2 text-xs font-medium text-cocoa transition group-hover:border-cocoa group-hover:bg-cocoa group-hover:text-cream">
                Order
              </button>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
