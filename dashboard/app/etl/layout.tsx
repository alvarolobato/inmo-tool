import type { ReactNode } from "react";
import AdminChrome from "@/app/admin/AdminChrome";

export default function EtlLayout({ children }: { children: ReactNode }) {
  return <AdminChrome>{children}</AdminChrome>;
}
