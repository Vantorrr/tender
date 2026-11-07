import Link from "next/link";
import { ArrowRight, FileSearch, ShieldCheck, Workflow } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Logo } from "@/components/logo";
import { Settle } from "@/components/settle";

const POINTS = [
  {
    icon: FileSearch,
    title: "Разбор документов",
    text: "PDF, DOCX, XLSX с аналитической запиской и цитатами из источника.",
  },
  {
    icon: Workflow,
    title: "Сквозная цепочка",
    text: "Закупка → документы → расчёт → ГПР → деньги → план/факт.",
  },
  {
    icon: ShieldCheck,
    title: "Роли и изоляция",
    text: "Шесть ролей, права на разделы и изоляция данных организаций.",
  },
];

export default function HomePage() {
  return (
    <div className="relative min-h-screen overflow-hidden">
      <div className="relative z-10 mx-auto flex min-h-screen max-w-6xl flex-col px-5 py-6 sm:px-8">
        <Settle delay={40} y={12} blur={6}>
          <header className="flex items-center justify-between gap-4">
            <Logo tone="ink" markClassName="h-11 w-11" titleClassName="text-lg sm:text-xl" />
            <Button
              render={<Link href="/login" />}
              className="rounded-full bg-[var(--tk-ink)] px-4 text-white hover:bg-[var(--tk-ink)]/90"
            >
              Войти в кабинет
            </Button>
          </header>
        </Settle>

        <section className="flex flex-1 flex-col justify-center py-16 sm:py-20">
          <Settle delay={120} y={18} blur={8}>
            <p className="mb-4 text-sm font-medium uppercase tracking-[0.18em] text-[var(--tk-copper-deep)]">
              Договор № TMA361 · 26.10.2026
            </p>
          </Settle>
          <Settle delay={220} y={36} blur={12}>
            <h1 className="max-w-3xl">
              <Logo tone="ink" titleClassName="text-4xl leading-[1.05] sm:text-5xl lg:text-6xl" />
            </h1>
          </Settle>
          <Settle delay={360} y={24} blur={8}>
            <p className="mt-5 max-w-xl text-base leading-relaxed text-[var(--tk-ink-soft)] sm:text-lg">
              Платформа отбора строительных тендеров: от ленты закупок до
              чернового расчёта, ГПР, денег и план/факта — в одном личном кабинете.
            </p>
          </Settle>
          <Settle delay={500} y={20} blur={6}>
            <div className="mt-8 flex flex-wrap gap-3">
              <Button
                render={<Link href="/login" />}
                size="lg"
                className="bg-[var(--tk-copper)] text-white hover:bg-[var(--tk-copper-deep)]"
              >
                Войти
                <ArrowRight className="h-4 w-4" />
              </Button>
              <Button
                render={<Link href="/cabinet/instrukciya" />}
                size="lg"
                variant="outline"
                className="tk-glass rounded-full border-white/70 text-[var(--tk-ink)] hover:bg-white/70 hover:text-[var(--tk-ink)]"
              >
                Инструкция по сценариям
              </Button>
            </div>
          </Settle>
        </section>

        <section className="grid gap-4 py-8 sm:grid-cols-3">
          {POINTS.map((item, index) => (
            <Settle key={item.title} delay={680 + index * 110} y={32} blur={8}>
              <div className="tk-glass rounded-3xl p-5">
                <item.icon className="mb-3 h-5 w-5 text-[var(--tk-copper-deep)]" />
                <h2 className="font-[family-name:var(--font-display)] text-base text-[var(--tk-ink)]">
                  {item.title}
                </h2>
                <p className="mt-1.5 text-sm leading-relaxed text-[var(--tk-muted)]">
                  {item.text}
                </p>
              </div>
            </Settle>
          ))}
        </section>
      </div>
    </div>
  );
}
