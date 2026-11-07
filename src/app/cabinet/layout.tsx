import { AppShell } from "@/components/cabinet/app-shell";

export default function CabinetLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <AppShell>{children}</AppShell>;
}
