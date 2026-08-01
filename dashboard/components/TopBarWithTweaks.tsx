"use client";

import { useState } from "react";
import { TopBar } from "@/components/TopBar";
import TweaksPanel from "@/components/TweaksPanel";

interface TopBarWithTweaksProps {
  /** Public URL of the dashboard app — passed from the server layout. */
  appPublicUrl: string;
  /** Public URL of WrenAI — passed from the server layout. */
  wrenPublicUrl: string;
}

/**
 * Wrapper that renders TopBar + TweaksPanel together, managing the open/close state.
 * This lives in layout.tsx so TweaksPanel is available on every page.
 * The public URLs are read server-side in layout.tsx and threaded down here so
 * client components can use runtime-configured hostnames without NEXT_PUBLIC_ baking.
 */
export function TopBarWithTweaks({ appPublicUrl, wrenPublicUrl }: TopBarWithTweaksProps) {
  const [tweaksOpen, setTweaksOpen] = useState(false);

  return (
    <>
      <TopBar
        onCogClick={() => setTweaksOpen((v) => !v)}
        appPublicUrl={appPublicUrl}
        wrenPublicUrl={wrenPublicUrl}
      />
      <TweaksPanel
        open={tweaksOpen}
        onClose={() => setTweaksOpen(false)}
      />
    </>
  );
}
