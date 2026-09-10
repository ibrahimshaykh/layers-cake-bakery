import type { Metadata } from "next";
import { Fraunces, Inter } from "next/font/google";
import "./globals.css";

const fraunces = Fraunces({
  variable: "--font-fraunces",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Layers Cake Bakery",
  description: "Cake, built the slow way. Layer by layer, baked fresh every morning.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${fraunces.variable} ${inter.variable}`}>
      <head>
        {/* Start the hero's first frame with the document rather than after
            the JS bundle parses — it gates the hero's first paint. The
            media queries mirror SMALL_SCREEN_QUERY in ScrollCakeHero, so a
            phone preloads the small set it will actually use and doesn't
            pay for a full-size frame it never draws. */}
        <link
          rel="preload"
          as="image"
          href="/frames/frame-001.webp"
          type="image/webp"
          media="(min-width: 821px)"
        />
        <link
          rel="preload"
          as="image"
          href="/frames-mobile/frame-001.webp"
          type="image/webp"
          media="(max-width: 820px)"
        />
      </head>
      <body className="bg-cream text-cocoa antialiased">{children}</body>
    </html>
  );
}
