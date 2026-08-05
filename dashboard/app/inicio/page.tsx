/**
 * Home (`/inicio`, and via app/page.tsx's re-export, `/`).
 *
 * Issue #195 retired the Phase-1 placeholder that used to live here ("la
 * ingesta de datos… el panel de candidatos y las vistas de inversión se están
 * construyendo en fases posteriores") — it described work that has long since
 * shipped and was the first, dead-end thing every session hit. Per the #176
 * design decision, `/` and `/inicio` now render the redesigned Perfiles surface
 * (with the "novedades" strip on top), rather than a second landing page. This
 * follows the existing app/page.tsx → inicio re-export pattern; components/home/*
 * (HeroToday/PeriodGrid/…) stay as dead code, untouched, per #195.
 */
export { default } from "../profiles/page";
