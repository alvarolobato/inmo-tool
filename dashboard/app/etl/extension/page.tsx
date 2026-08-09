"use client";

import { ExtensionSetup } from "@/components/extension/ExtensionSetup";

/**
 * Extension setup page (issue #256).
 *
 * Since #509 this route is no longer an admin nav tab — the setup is surfaced
 * inline via the `<ExtensionCta/>` modal wherever capture actually happens. The
 * route stays routable as the canonical deep-link target of that modal's "abrir
 * en página completa" link, rendering the same shared {@link ExtensionSetup}
 * block (download the packaged extension, copy the API URL + key).
 *
 * Admin-gated by middleware (`/etl/:path*`), same as every surface under /etl.
 */
export default function ExtensionSetupPage() {
  return (
    <div data-testid="extension-setup-page" className="mx-auto max-w-3xl space-y-6">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold text-tremor-content-strong dark:text-dark-tremor-content-strong">
          Configurar la extensión de captura
        </h1>
        <p className="text-sm text-tremor-content dark:text-dark-tremor-content">
          Descarga la extensión, cárgala en Chrome y pega la URL y la clave de abajo en sus
          opciones. Chrome no permite instalar extensiones sin empaquetar desde una página web,
          así que el paso de carga es manual (una sola vez).
        </p>
      </header>

      <ExtensionSetup />
    </div>
  );
}
