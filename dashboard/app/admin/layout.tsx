import type { ReactNode } from "react";
import AdminChrome from "./AdminChrome";

export default function AdminLayout({ children }: { children: ReactNode }) {
  return <AdminChrome>{children}</AdminChrome>;
}
