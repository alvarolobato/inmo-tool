/**
 * Digest email rendering + SMTP delivery (issue #35, Phase 5.5 v1).
 *
 * ## Why email, why SMTP, why nodemailer
 *
 * Issue #1 §17's open question defaulted the digest channel to email as the
 * most universally available channel absent an owner preference, and this repo
 * had NO mail infrastructure before this task. `nodemailer` is the de-facto
 * Node SMTP client — a single small dependency, no heavyweight
 * marketing-email platform (this is a personal tool, one owner). SMTP creds
 * come from `config/schema.yaml` (`notifications.smtp_*`), never hardcoded.
 * Slack/push channels are plausible future additions but out of scope (#35).
 *
 * ## No-op when unconfigured — never crash a deployment without SMTP
 *
 * `sendDigestEmail` is a logged no-op when SMTP is not configured (no host /
 * no from address): it returns `{ sent: false, reason: "smtp-not-configured" }`
 * instead of throwing, so a deployment that never set SMTP up still runs the
 * digest scheduler harmlessly (the watermark still advances). It also never
 * throws on a transport failure — a send error is logged and folded into the
 * result, so one bad send can't kill the scheduler loop.
 *
 * Server-only.
 */

import type { DigestContent, DigestNewCandidate } from "./digest";
import { readConfigString, readBool, readPositiveInt } from "./config-read";

export interface SmtpConfig {
  host: string | null;
  port: number;
  user: string | null;
  password: string | null;
  /** From address (e.g. "inmo-tool <digest@example.com>"). */
  from: string | null;
  /** SMTPS (implicit TLS, usually port 465). STARTTLS on 587 leaves this false. */
  secure: boolean;
  /** Global fallback recipient when a profile has no `digest_email` of its own. */
  defaultTo: string | null;
}

export function loadSmtpConfig(): SmtpConfig {
  return {
    host: readConfigString("notifications.smtp_host", "NOTIFICATIONS_SMTP_HOST"),
    port: readPositiveInt("notifications.smtp_port", "NOTIFICATIONS_SMTP_PORT", 587),
    user: readConfigString("notifications.smtp_user", "NOTIFICATIONS_SMTP_USER"),
    password: readConfigString("notifications.smtp_password", "NOTIFICATIONS_SMTP_PASSWORD"),
    from: readConfigString("notifications.smtp_from", "NOTIFICATIONS_SMTP_FROM"),
    secure: readBool("notifications.smtp_secure", "NOTIFICATIONS_SMTP_SECURE", false),
    defaultTo: readConfigString("notifications.digest_to", "NOTIFICATIONS_DIGEST_TO"),
  };
}

/**
 * SMTP is "configured enough to send" once it has a host and a from address.
 * User/password are optional (an unauthenticated relay is valid); recipient is
 * checked separately (it can come from the profile, not just the config).
 */
export function isSmtpConfigured(cfg: SmtpConfig): boolean {
  return cfg.host !== null && cfg.from !== null;
}

/** A profile's own `digest_email` wins; otherwise the global `notifications.digest_to`. */
export function resolveRecipient(cfg: SmtpConfig, profileEmail: string | null): string | null {
  const own = profileEmail?.trim();
  if (own) return own;
  return cfg.defaultTo;
}

// ─── Rendering ────────────────────────────────────────────────────────────

const eur = (n: number | null): string =>
  n == null ? "—" : new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(n);

const pct = (fraction: number): string => `${Math.round(fraction * 100)}%`;

const eurPerM2 = (n: number | null): string => (n == null ? "" : `${Math.round(n)} €/m²`);

function candidateLine(c: DigestNewCandidate): string {
  const parts: string[] = [];
  parts.push(eur(c.price));
  if (c.m2 != null) parts.push(`${Math.round(c.m2)} m²`);
  if (c.pricePerM2 != null) parts.push(eurPerM2(c.pricePerM2));
  if (c.zone) parts.push(c.zone);
  if (c.sources.length) parts.push(c.sources.join(", "));
  const badges: string[] = [];
  if (c.belowMarketPct != null) badges.push(`${pct(c.belowMarketPct)} bajo mercado`);
  for (const rf of c.redFlags) badges.push(rf);
  for (const f of c.flags) badges.push(f.label);
  const badgeStr = badges.length ? ` [${badges.join(" · ")}]` : "";
  return `${parts.join(" · ")}${badgeStr}`;
}

/**
 * Render the digest to `{ subject, text, html }`. Pure — no I/O, no config.
 * The three item types are rendered as DISTINCT, separately-headed sections
 * (issue #35 technical approach §1) so the investor can tell at a glance which
 * kind of thing happened. New candidates come pre-ranked by the builder.
 */
export function renderDigestEmail(content: DigestContent): { subject: string; text: string; html: string } {
  const nSeg = content.seguimientoDrops.length;
  const nNew = content.newCandidates.length;
  const nDrop = content.priceDrops.length;
  const nStatus = content.statusChanges.length;
  const nRelist = content.relistedLower.length;
  // #428: seguimiento drops lead the subject — a drop on a tracked property is
  // the single most actionable event this digest can carry.
  const segPart = nSeg > 0 ? `${nSeg} en seguimiento · ` : "";
  const relistPart = nRelist > 0 ? ` · ${nRelist} rebajas tras retirada` : "";
  const subject = `Novedades ${content.profileName}: ${segPart}${nNew} nuevas · ${nDrop} bajadas · ${nStatus} cambios${relistPart}`;

  // ── Plain text ──
  const lines: string[] = [];
  lines.push(`Novedades — ${content.profileName}`);
  lines.push(`Desde ${content.since}`);
  lines.push("");
  // #428: top-placed "En seguimiento" section — separate from, and above, the
  // generic price-drops section below.
  if (nSeg > 0) {
    lines.push(`EN SEGUIMIENTO — BAJADAS (${nSeg})`);
    content.seguimientoDrops.forEach((d) => {
      lines.push(`  ${eur(d.oldPrice)} → ${eur(d.newPrice)} (−${pct(d.dropPct)}) · ${d.source}${d.zone ? ` · ${d.zone}` : ""}`);
      if (d.url) lines.push(`     ${d.url}`);
    });
    lines.push("");
  }
  if (nNew > 0) {
    lines.push(`NUEVOS CANDIDATOS (${nNew})`);
    content.newCandidates.forEach((c, i) => {
      lines.push(`  ${i + 1}. ${candidateLine(c)}`);
      if (c.url) lines.push(`     ${c.url}`);
    });
    lines.push("");
  }
  if (nDrop > 0) {
    lines.push(`BAJADAS DE PRECIO (${nDrop})`);
    content.priceDrops.forEach((d) => {
      lines.push(`  ${eur(d.oldPrice)} → ${eur(d.newPrice)} (−${pct(d.dropPct)}) · ${d.source}${d.zone ? ` · ${d.zone}` : ""}`);
      if (d.url) lines.push(`     ${d.url}`);
    });
    lines.push("");
  }
  if (nStatus > 0) {
    lines.push(`CAMBIOS DE ESTADO (${nStatus})`);
    content.statusChanges.forEach((s) => {
      const label = s.status === "sold" ? "Vendido" : "Retirado";
      lines.push(`  ${label} · ${s.source}${s.zone ? ` · ${s.zone}` : ""}`);
      if (s.url) lines.push(`     ${s.url}`);
    });
    lines.push("");
  }
  // #428 (EC-4): withdrawn-then-relisted-lower — motivated-seller signal.
  if (nRelist > 0) {
    lines.push(`REBAJAS TRAS RETIRADA (${nRelist})`);
    content.relistedLower.forEach((r) => {
      lines.push(`  ${eur(r.withdrawnPrice)} → ${eur(r.relistedPrice)} (−${pct(r.dropPct)})${r.zone ? ` · ${r.zone}` : ""}`);
    });
    lines.push("");
  }
  const text = lines.join("\n");

  // ── HTML ──
  const esc = (s: string): string =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const link = (url: string | null, label: string): string =>
    url ? `<a href="${esc(url)}">${esc(label)}</a>` : esc(label);
  const html: string[] = [];
  html.push(`<h2>Novedades — ${esc(content.profileName)}</h2>`);
  html.push(`<p style="color:#666">Desde ${esc(content.since)}</p>`);
  // #428: top-placed "En seguimiento" section, visually distinct from the
  // generic bajadas below.
  if (nSeg > 0) {
    html.push(`<h3 style="border-left:3px solid #16a34a;padding-left:8px">En seguimiento — bajadas (${nSeg})</h3><ul>`);
    for (const d of content.seguimientoDrops) {
      const label = `${eur(d.oldPrice)} → ${eur(d.newPrice)} (−${pct(d.dropPct)}) · ${d.source}${d.zone ? ` · ${d.zone}` : ""}`;
      html.push(`<li>${link(d.url, label)}</li>`);
    }
    html.push("</ul>");
  }
  if (nNew > 0) {
    html.push(`<h3>Nuevos candidatos (${nNew})</h3><ul>`);
    for (const c of content.newCandidates) html.push(`<li>${link(c.url, candidateLine(c))}</li>`);
    html.push("</ul>");
  }
  if (nDrop > 0) {
    html.push(`<h3>Bajadas de precio (${nDrop})</h3><ul>`);
    for (const d of content.priceDrops) {
      const label = `${eur(d.oldPrice)} → ${eur(d.newPrice)} (−${pct(d.dropPct)}) · ${d.source}${d.zone ? ` · ${d.zone}` : ""}`;
      html.push(`<li>${link(d.url, label)}</li>`);
    }
    html.push("</ul>");
  }
  if (nStatus > 0) {
    html.push(`<h3>Cambios de estado (${nStatus})</h3><ul>`);
    for (const s of content.statusChanges) {
      const statusLabel = s.status === "sold" ? "Vendido" : "Retirado";
      const label = `${statusLabel} · ${s.source}${s.zone ? ` · ${s.zone}` : ""}`;
      html.push(`<li>${link(s.url, label)}</li>`);
    }
    html.push("</ul>");
  }
  if (nRelist > 0) {
    html.push(`<h3>Rebajas tras retirada (${nRelist})</h3><ul>`);
    for (const r of content.relistedLower) {
      const label = `${eur(r.withdrawnPrice)} → ${eur(r.relistedPrice)} (−${pct(r.dropPct)})${r.zone ? ` · ${r.zone}` : ""}`;
      html.push(`<li>${esc(label)}</li>`);
    }
    html.push("</ul>");
  }

  return { subject, text, html: html.join("\n") };
}

// ─── Sending ──────────────────────────────────────────────────────────────

export interface SendResult {
  sent: boolean;
  /** Why nothing was sent, when `sent` is false. */
  reason?: "smtp-not-configured" | "no-recipient" | "send-failed";
  recipient?: string;
}

/**
 * Send the digest by email, or a logged no-op when SMTP/recipient are missing.
 * Never throws — a transport failure is logged and returned as
 * `{ sent: false, reason: "send-failed" }` so the scheduler loop survives.
 * `nodemailer` is imported lazily so the unconfigured path never loads it.
 */
export async function sendDigestEmail(
  content: DigestContent,
  opts: { to?: string | null } = {},
): Promise<SendResult> {
  const cfg = loadSmtpConfig();
  const recipient = resolveRecipient(cfg, opts.to ?? null);

  if (!isSmtpConfigured(cfg)) {
    console.info(
      `[digest] SMTP not configured — skipping send for "${content.profileName}" (would have gone to ${recipient ?? "no recipient"}).`,
    );
    return { sent: false, reason: "smtp-not-configured" };
  }
  if (!recipient) {
    console.warn(`[digest] no recipient for "${content.profileName}" — set notifications.digest_to or the profile's digest_email.`);
    return { sent: false, reason: "no-recipient" };
  }

  const { subject, text, html } = renderDigestEmail(content);
  try {
    const nodemailer = await import("nodemailer");
    const transport = nodemailer.createTransport({
      host: cfg.host!,
      port: cfg.port,
      secure: cfg.secure,
      auth: cfg.user ? { user: cfg.user, pass: cfg.password ?? "" } : undefined,
    });
    await transport.sendMail({ from: cfg.from!, to: recipient, subject, text, html });
    console.info(`[digest] sent digest for "${content.profileName}" to ${recipient}.`);
    return { sent: true, recipient };
  } catch (err) {
    console.error(`[digest] send failed for "${content.profileName}":`, err);
    return { sent: false, reason: "send-failed", recipient };
  }
}
