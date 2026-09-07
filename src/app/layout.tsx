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
        {/* Start the hero's first frames with the document rather than
            after the JS bundle parses — they gate the hero's first paint. */}
        <link rel="preload" as="image" href="/frames/frame-001.webp" type="image/webp" />
        <link rel="preload" as="image" href="/frames/frame-002.webp" type="image/webp" />
      </head>
      <body className="bg-cream text-cocoa antialiased">{children}</body>
    </html>
  );
}
