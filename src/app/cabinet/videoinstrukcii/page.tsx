"use client";

import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";

const cards = [
  { title: "Как завести закупку", text: "Скоро появятся" },
  { title: "Как собрать расчёт", text: "Скоро появятся" },
  { title: "Как вести график и факт", text: "Скоро появятся" },
];

export default function VideoInstructionsPage() {
  return (
    <>
      <PageHeader title="Видеоинструкции" description="Короткие ролики по работе в кабинете." />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {cards.map((card) => (
          <article key={card.title} className="rounded-xl border border-[var(--tk-line)] bg-white p-4">
            <h2 className="font-semibold">{card.title}</h2>
            <p className="mt-2 text-sm text-[var(--tk-muted)]">{card.text}</p>
            <div className="mt-4 flex gap-2">
              <Button size="sm" disabled>Смотреть</Button>
              <Button size="sm" variant="outline" disabled>Позже</Button>
            </div>
          </article>
        ))}
      </div>
    </>
  );
}
