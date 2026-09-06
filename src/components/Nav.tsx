"use client";

import { useEffect, useState } from "react";
import { brand, nav } from "@/content/site";

export default function Nav() {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 40);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header
      className={`fixed inset-x-0 top-0 z-50 transition-colors duration-300 ${
        scrolled ? "bg-cream/90 backdrop-blur shadow-sm" : "bg-transparent"
      }`}
    >
      <nav className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
        <a href="#top" className="font-display text-xl font-medium text-cocoa">
          {brand.name}
        </a>
        <ul className="hidden gap-8 text-sm font-medium text-cocoa-light sm:flex">
          {nav.map((item) => (
            <li key={item.href}>
              <a href={item.href} className="transition hover:text-cocoa">
                {item.label}
              </a>
            </li>
          ))}
        </ul>
        <a
          href="#menu"
          className="rounded-full bg-cocoa px-5 py-2 text-sm font-medium text-cream transition hover:bg-cocoa-light"
        >
          Order
        </a>
      </nav>
    </header>
  );
}
