import { AppShell } from "@/components/cabinet/app-shell";
import { SectionGate } from "@/components/cabinet/section-gate";

export default function CabinetLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <AppShell>
      <SectionGate>{children}</SectionGate>
    </AppShell>
  );
}
