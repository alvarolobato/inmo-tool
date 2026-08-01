import { redirect } from "next/navigation";

/**
 * The glossary is accessible within each dashboard via the Glosario button
 * in the dashboard toolbar. There is no standalone glossary page — redirect
 * to the dashboard list so users can open a dashboard and access it there.
 */
export default function GlossaryPage() {
  redirect("/");
}
