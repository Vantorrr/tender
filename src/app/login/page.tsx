"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { LoadingState } from "@/components/empty-state";
import { ROLE_LABELS } from "@/lib/roles";
import { useStore } from "@/lib/store";

const DEMO_HINTS = [
  { email: "super@tenderkontur.ru", password: "Super123!", role: "superadmin" as const },
  { email: "tender@alfastroy.ru", password: "Tender123!", role: "tender" as const },
  { email: "smeta@alfastroy.ru", password: "Smeta123!", role: "smetchik" as const },
];

export default function LoginPage() {
  const { ready, user, login } = useStore();
  const router = useRouter();
  const [email, setEmail] = useState("tender@alfastroy.ru");
  const [password, setPassword] = useState("Tender123!");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (ready && user) router.replace("/cabinet");
  }, [ready, user, router]);

  if (!ready) return <LoadingState />;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");
    const result = login(email, password);
    setLoading(false);
    if (!result.ok) {
      setError(result.error ?? "Ошибка входа");
      return;
    }
    toast.success("Добро пожаловать в ТендерКонтур");
    router.push("/cabinet");
  }

  return (
    <div className="relative flex min-h-screen items-center justify-center px-4 py-10">
      <div className="tk-hero-wash absolute inset-0 opacity-90" />
      <div className="tk-grid-bg absolute inset-0 opacity-30" />

      <div className="relative z-10 grid w-full max-w-5xl overflow-hidden rounded-2xl border border-white/15 bg-white/95 shadow-[0_30px_80px_-40px_rgba(15,36,48,0.7)] lg:grid-cols-[1.1fr_0.9fr]">
        <div className="hidden flex-col justify-between bg-[linear-gradient(160deg,#14232e,#1b3a4b_55%,#2a4f5f)] p-10 text-white lg:flex">
          <div>
            <div className="mb-8 flex items-center gap-3">
              <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-white/10 font-[family-name:var(--font-display)] font-bold ring-1 ring-white/20">
                ТК
              </span>
              <span className="font-[family-name:var(--font-display)] text-2xl tracking-tight">
                ТендерКонтур
              </span>
            </div>
            <h1 className="font-[family-name:var(--font-display)] text-3xl leading-tight tracking-tight">
              Вход в личный кабинет
            </h1>
            <p className="mt-3 max-w-sm text-sm leading-relaxed text-white/75">
              Мок-аутентификация для демо по ТЗ TMA361. Выберите роль ниже или
              введите учётные данные.
            </p>
          </div>
          <p className="text-xs text-white/50">Договор № TMA361 · 26.10.2026</p>
        </div>

        <div className="p-6 sm:p-10">
          <div className="mb-8 lg:hidden">
            <Link
              href="/"
              className="font-[family-name:var(--font-display)] text-xl text-[var(--tk-ink)]"
            >
              ТендерКонтур
            </Link>
          </div>

          <form onSubmit={onSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                autoComplete="username"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">Пароль</Label>
              <Input
                id="password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </div>
            {error ? (
              <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
                {error}
              </p>
            ) : null}
            <Button type="submit" className="w-full" disabled={loading} size="lg">
              {loading ? "Вход…" : "Войти"}
            </Button>
          </form>

          <div className="mt-4 flex items-center justify-between text-sm">
            <Link
              href="/recover"
              className="text-[var(--tk-copper-deep)] hover:underline"
            >
              Восстановить пароль
            </Link>
            <Link href="/" className="text-[var(--tk-muted)] hover:underline">
              На главную
            </Link>
          </div>

          <div className="mt-8 border-t border-[var(--tk-line)] pt-6">
            <p className="mb-3 text-xs font-medium uppercase tracking-wide text-[var(--tk-muted)]">
              Быстрый вход (демо)
            </p>
            <div className="flex flex-col gap-2">
              {DEMO_HINTS.map((d) => (
                <button
                  key={d.email}
                  type="button"
                  className="rounded-lg border border-[var(--tk-line)] px-3 py-2 text-left text-sm transition hover:border-[var(--tk-copper)]/50 hover:bg-[var(--tk-steel-50)]"
                  onClick={() => {
                    setEmail(d.email);
                    setPassword(d.password);
                  }}
                >
                  <span className="font-medium text-[var(--tk-ink)]">
                    {ROLE_LABELS[d.role]}
                  </span>
                  <span className="mt-0.5 block text-xs text-[var(--tk-muted)]">
                    {d.email}
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
