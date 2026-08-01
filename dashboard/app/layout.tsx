import type { Metadata } from "next";
import type { ReactNode } from "react";
import localFont from "next/font/local";
import ThemeProvider from "@/components/ThemeProvider";
import { TweaksPanelProvider } from "@/components/TweaksPanel";
import { TopBarWithTweaks } from "@/components/TopBarWithTweaks";
import { FreshnessProvider } from "@/components/FreshnessContext";
import { getAppPublicUrl, getWrenPublicUrl } from "@/lib/public-urls";
import "./globals.css";

// Force dynamic rendering so public URL changes in config.yaml take effect
// on the next page load without requiring a container restart.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "PowerShop Dashboard",
  description: "Cuadros de mando generados con inteligencia artificial para PowerShop Analytics",
};

// Fonts are self-hosted under public/fonts/ to avoid network fetches at Docker
// build time (Google Fonts is unreachable inside the build container).
const inter = localFont({
  src: [
    { path: "../public/fonts/inter-400.woff2", weight: "400", style: "normal" },
    { path: "../public/fonts/inter-500.woff2", weight: "500", style: "normal" },
    { path: "../public/fonts/inter-600.woff2", weight: "600", style: "normal" },
    { path: "../public/fonts/inter-700.woff2", weight: "700", style: "normal" },
    { path: "../public/fonts/inter-800.woff2", weight: "800", style: "normal" },
  ],
  variable: "--font-inter",
  display: "swap",
});

const jetbrainsMono = localFont({
  src: [
    { path: "../public/fonts/jetbrains-mono-400.woff2", weight: "400", style: "normal" },
    { path: "../public/fonts/jetbrains-mono-500.woff2", weight: "500", style: "normal" },
    { path: "../public/fonts/jetbrains-mono-600.woff2", weight: "600", style: "normal" },
  ],
  variable: "--font-jetbrains",
  display: "swap",
});

// Pre-paint script: reads ps.tweaks.v1 (and falls back to legacy "theme" key)
// and applies data-theme, data-accent, data-density to <html> before first paint.
const preloadScript = `(function(){
  try {
    var el = document.documentElement;
    // Try new key first
    var raw = localStorage.getItem('ps.tweaks.v1');
    if (raw) {
      try {
        var t = JSON.parse(raw);
        if (t.theme === 'light' || t.theme === 'dark') {
          el.setAttribute('data-theme', t.theme);
          if (t.theme === 'light') { el.classList.remove('dark'); } else { el.classList.add('dark'); }
        }
        if (t.accent) { el.setAttribute('data-accent', t.accent); }
        if (t.density) { el.setAttribute('data-density', t.density); }
      } catch(e) {}
    } else {
      // Fallback: legacy "theme" key
      var legacy = localStorage.getItem('theme');
      if (legacy === 'light') {
        el.setAttribute('data-theme', 'light');
        el.classList.remove('dark');
      } else {
        el.setAttribute('data-theme', 'dark');
        el.classList.add('dark');
      }
    }
  } catch(e) {}
})();`;
export default function RootLayout({
  children,
}: {
  children: ReactNode;
}) {
  // Read public URLs at server-render time so the same Docker image works
  // for any hostname (localhost in dev, custom domain in production).
  const appPublicUrl = getAppPublicUrl();
  const wrenPublicUrl = getWrenPublicUrl();

  return (
    <html
      lang="es"
      data-theme="dark"
      data-accent="electric"
      className="dark"
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: preloadScript }} />
      </head>
      <body
        className={`${inter.variable} ${jetbrainsMono.variable} antialiased`}
        style={{
          display: "flex",
          flexDirection: "column",
          height: "100vh",
          background: "var(--bg)",
          color: "var(--fg)",
          fontFamily: "var(--font-inter), sans-serif",
          fontVariantNumeric: "tabular-nums",
          fontFeatureSettings: '"tnum"',
        }}
      >
        <ThemeProvider>
          <FreshnessProvider>
            <TweaksPanelProvider>
              <TopBarWithTweaks appPublicUrl={appPublicUrl} wrenPublicUrl={wrenPublicUrl} />
              <main style={{ flex: 1, overflow: "auto" }} className="main-content">{children}</main>
            </TweaksPanelProvider>
          </FreshnessProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
