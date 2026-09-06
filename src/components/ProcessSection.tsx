import { process } from "@/content/site";

export default function ProcessSection() {
  return (
    <section id="process" className="bg-cream-dark py-24">
      <div className="mx-auto max-w-6xl px-6">
        <div className="mb-14 max-w-xl">
          <p className="text-xs uppercase tracking-[0.3em] text-caramel">How it&apos;s made</p>
          <h2 className="mt-3 font-display text-4xl font-medium text-cocoa sm:text-5xl">
            From batter to box.
          </h2>
        </div>

        <div className="grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
          {process.map((step) => (
            <div key={step.step} className="relative">
              <span className="font-display text-5xl text-blush-dark">{step.step}</span>
              <h3 className="mt-4 font-display text-lg font-medium text-cocoa">
                {step.title}
              </h3>
              <p className="mt-2 text-sm text-cocoa-light">{step.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
