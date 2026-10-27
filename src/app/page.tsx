import Link from "next/link";
import { ArrowRight, FileSearch, ShieldCheck, Workflow } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function HomePage() {
  return (
    <div className="relative min-h-screen overflow-hidden">
      <div className="tk-hero-wash absolute inset-0" />
      <div className="tk-grid-bg absolute inset-0 opacity-40" />
      <div className="animate-drift absolute -right-24 top-10 h-80 w-80 rounded-full bg-[radial-gradient(circle,rgba(184,107,43,0.35),transparent_70%)] blur-2xl" />
      <div className="animate-drift absolute -left-16 bottom-10 h-72 w-72 rounded-full bg-[radial-gradient(circle,rgba(120,180,200,0.25),transparent_70%)] blur-2xl" />

      <div className="relative z-10 mx-auto flex min-h-screen max-w-6xl flex-col px-5 py-6 sm:px-8">
        <header className="animate-rise flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-white/10 font-[family-name:var(--font-display)] text-sm font-bold text-white ring-1 ring-white/20">
              ТК
            </span>
            <span className="font-[family-name:var(--font-display)] text-lg tracking-tight text-white sm:text-xl">
              ТендерКонтур
            </span>
          </div>
          <Button
            render={<Link href="/login" />}
            variant="secondary"
            className="bg-white/95 text-[var(--tk-steel)] hover:bg-white"
          >
            Войти в кабинет
          </Button>
        </header>

        <section className="flex flex-1 flex-col justify-center py-16 sm:py-20">
          <p className="animate-rise mb-4 text-sm font-medium uppercase tracking-[0.18em] text-[var(--tk-sand)]">
            Договор № TMA361 · 26.10.2026
          </p>
          <h1 className="animate-rise-delay max-w-3xl font-[family-name:var(--font-display)] text-4xl leading-[1.05] tracking-tight text-white sm:text-5xl lg:text-6xl">
            ТендерКонтур
          </h1>
          <p className="animate-rise-delay mt-5 max-w-xl text-base leading-relaxed text-white/80 sm:text-lg">
            Платформа отбора строительных тендеров: от ленты закупок до
            чернового расчёта, ГПР, денег и план/факта — в одном личном кабинете.
          </p>
          <div className="animate-rise-delay-2 mt-8 flex flex-wrap gap-3">
            <Button
              render={<Link href="/login" />}
              size="lg"
              className="bg-[var(--tk-copper)] text-white hover:bg-[var(--tk-copper-deep)]"
            >
              Открыть демо
              <ArrowRight className="h-4 w-4" />
            </Button>
            <Button
              render={<Link href="/cabinet/instrukciya" />}
              size="lg"
              variant="outline"
              className="border-white/30 bg-white/5 text-white hover:bg-white/10 hover:text-white"
            >
              Инструкция по сценариям
            </Button>
          </div>
        </section>

        <section className="animate-rise-delay-2 grid gap-4 border-t border-white/15 py-8 sm:grid-cols-3">
          {[
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
          ].map((item) => (
            <div
              key={item.title}
              className="rounded-xl border border-white/10 bg-white/5 p-4 backdrop-blur-sm"
            >
              <item.icon className="mb-3 h-5 w-5 text-[var(--tk-sand)]" />
              <h2 className="font-[family-name:var(--font-display)] text-base text-white">
                {item.title}
              </h2>
              <p className="mt-1.5 text-sm leading-relaxed text-white/70">
                {item.text}
              </p>
            </div>
          ))}
        </section>
      </div>
    </div>
  );
}
