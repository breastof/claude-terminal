import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono, Space_Grotesk } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin", "cyrillic"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const spaceGrotesk = Space_Grotesk({
  variable: "--font-space-grotesk",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

export const metadata: Metadata = {
  title: "Claude Terminal",
  description: "Web interface for Claude CLI",
};

// Viewport meta — frozen string per `05-decision-mobile.md §2.6`.
// Emits: <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content">
// `viewport-fit=cover` activates env(safe-area-inset-*); `interactive-widget=resizes-content`
// makes Chrome 108+ shrink the layout viewport when the soft keyboard opens.
// `themeColor: "#000000"` aligns the iOS Safari status-bar tint with the dark theme.
// `user-scalable` is intentionally NOT pinned so users can pinch-zoom terminal output.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  interactiveWidget: "resizes-content",
  themeColor: "#000000",
};

// Inline script to prevent FOUC — reads localStorage before first paint
const themeScript = `(function(){try{if(localStorage.getItem("theme")==="retro")document.documentElement.setAttribute("data-theme","retro")}catch(e){}})()`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ru" className="dark" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body
        className={`${geistSans.variable} ${geistMono.variable} ${spaceGrotesk.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
