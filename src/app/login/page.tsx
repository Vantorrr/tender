"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { LoadingState } from "@/components/empty-state";
import { Logo } from "@/components/logo";
import { ROLE_LABELS } from "@/lib/roles";
import { DEMO_SECRET_KEYS } from "@/lib/demo-accounts";
import { useStore } from "@/lib/store";

const DEMO_HINTS = [
  { email: "super@tenderkontur.ru", password: "Super123!", role: "superadmin" as const },
  { email: "admin@alfastroy.ru", password: "Admin123!", role: "admin" as const },
  { email: "tender@alfastroy.ru", password: "Tender123!", role: "tender" as const },
  { email: "smeta@alfastroy.ru", password: "Smeta123!", role: "smetchik" as const },
];

const DEMO_KEYS = [
  { label: "Суперадмин", key: DEMO_SECRET_KEYS.super },
  { label: "Администратор", key: DEMO_SECRET_KEYS.admin },
];

export default function LoginPage() {
  const { ready, user, login, loginWithSecret } = useStore();
  const router = useRouter();
  const [mode, setMode] = useState<"password" | "key">("password");
  const [email, setEmail] = useState("tender@alfastroy.ru");
  const [password, setPassword] = useState("Tender123!");
  const [secretKey, setSecretKey] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (ready && user) router.replace("/cabinet");
  }, [ready, user, router]);

  if (!ready) return <LoadingState />;

  async function finish(result: { ok: boolean; error?: string }) {
    setLoading(false);
    if (!result.ok) {
      setError(result.error ?? "Ошибка входа");
      return;
    }
    toast.success("Добро пожаловать в ТендерКонтур");
    router.push("/cabinet");
  }

  async function doLogin(nextEmail: string, nextPassword: string) {
    setLoading(true);
    setError("");
    await finish(await login(nextEmail, nextPassword));
  }

  async function doKeyLogin(nextKey: string) {
    setLoading(true);
    setError("");
    await finish(await loginWithSecret(nextKey));
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (mode === "key") await doKeyLogin(secretKey);
    else await doLogin(email, password);
  }

  return (
    <div className="relative flex min-h-screen items-center justify-center px-4 py-10">
      <div className="tk-hero-wash absolute inset-0 opacity-90" />
      <div className="tk-grid-bg absolute inset-0 opacity-30" />

      <div className="relative z-10 grid w-full max-w-5xl overflow-hidden rounded-[28px] border border-white/10 bg-white shadow-[0_30px_80px_-36px_rgba(12,14,18,0.65)] lg:grid-cols-[1.05fr_0.95fr]">
        <div className="hidden flex-col justify-between bg-[#111318] p-10 text-white lg:flex">
          <div>
            <div className="mb-8">
              <Logo markClassName="h-12 w-12" titleClassName="text-2xl" />
            </div>
            <h1 className="font-[family-name:var(--font-display)] text-3xl leading-tight tracking-tight">
              Вход в личный кабинет
            </h1>
            <p className="mt-3 max-w-sm text-sm leading-relaxed text-white/75">
              Вход по email и паролю. Суперадмин и администратор также входят
              секретным ключом.
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
            <div className="grid grid-cols-2 gap-1 rounded-xl bg-[#f3f4f6] p-1">
              <button
                type="button"
                className={`rounded-lg px-3 py-2 text-sm font-medium ${
                  mode === "password"
                    ? "bg-white text-[var(--tk-ink)] shadow-sm"
                    : "text-[var(--tk-muted)]"
                }`}
                onClick={() => {
                  setMode("password");
                  setError("");
                }}
              >
                Пароль
              </button>
              <button
                type="button"
                className={`rounded-lg px-3 py-2 text-sm font-medium ${
                  mode === "key"
                    ? "bg-white text-[var(--tk-ink)] shadow-sm"
                    : "text-[var(--tk-muted)]"
                }`}
                onClick={() => {
                  setMode("key");
                  setError("");
                }}
              >
                Секретный ключ
              </button>
            </div>

            {mode === "password" ? (
              <>
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
              </>
            ) : (
              <div className="space-y-2">
                <Label htmlFor="secretKey">Секретный ключ</Label>
                <Input
                  id="secretKey"
                  type="password"
                  autoComplete="off"
                  placeholder="TK-…"
                  value={secretKey}
                  onChange={(e) => setSecretKey(e.target.value)}
                  required
                />
                <p className="text-xs text-[var(--tk-muted)]">
                  Ключ есть только у суперадмина и администратора. Он
                  показывается один раз при выдаче.
                </p>
              </div>
            )}
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
              {mode === "password" ? "Быстрый вход (демо)" : "Демо-ключи"}
            </p>
            <div className="flex flex-col gap-2">
              {mode === "password"
                ? DEMO_HINTS.map((d) => (
                    <button
                      key={d.email}
                      type="button"
                      disabled={loading}
                      className="rounded-lg border border-[var(--tk-line)] px-3 py-2 text-left text-sm transition hover:border-[var(--tk-copper)]/50 hover:bg-[var(--tk-steel-50)] disabled:opacity-50"
                      onClick={() => {
                        setEmail(d.email);
                        setPassword(d.password);
                        void doLogin(d.email, d.password);
                      }}
                    >
                      <span className="font-medium text-[var(--tk-ink)]">
                        {ROLE_LABELS[d.role]}
                      </span>
                      <span className="mt-0.5 block text-xs text-[var(--tk-muted)]">
                        {d.email}
                      </span>
                    </button>
                  ))
                : DEMO_KEYS.map((d) => (
                    <button
                      key={d.key}
                      type="button"
                      disabled={loading}
                      className="rounded-lg border border-[var(--tk-line)] px-3 py-2 text-left text-sm transition hover:border-[var(--tk-copper)]/50 hover:bg-[var(--tk-steel-50)] disabled:opacity-50"
                      onClick={() => {
                        setSecretKey(d.key);
                        void doKeyLogin(d.key);
                      }}
                    >
                      <span className="font-medium text-[var(--tk-ink)]">
                        {d.label}
                      </span>
                      <span className="mt-0.5 block font-mono text-xs text-[var(--tk-muted)]">
                        {d.key}
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
