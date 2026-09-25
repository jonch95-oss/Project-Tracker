import type { Metadata, Viewport } from "next";
import { GeistSans } from "geist/font/sans";
import localFont from "next/font/local";
import "./globals.css";

const display = localFont({
  src: [{ path: "../fonts/instrument-serif-latin-400-normal.woff2", weight: "400", style: "normal" }],
  variable: "--font-display",
  display: "swap",
});

// Numbers and shortcuts only, never the first thing on screen: not preloaded, so the first paint waits on two fonts, not three.
const mono = localFont({
  src: "../../node_modules/geist/dist/fonts/geist-mono/GeistMono-Variable.woff2",
  variable: "--font-geist-mono",
  weight: "100 900",
  display: "swap",
  preload: false,
});

export const metadata: Metadata = {
  title: { default: "Project Command", template: "%s · Project Command" },
  description: "Development project tracker for Ariel Development and Lian Development.",
  applicationName: "Project Command",
  appleWebApp: { capable: true, title: "Command", statusBarStyle: "default" },
  formatDetection: { telephone: false },
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#F5F2EC" },
    { media: "(prefers-color-scheme: dark)", color: "#141311" },
  ],
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${mono.variable} ${display.variable}`} suppressHydrationWarning>
      <body className="min-h-dvh">{children}</body>
    </html>
  );
}
