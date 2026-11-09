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
import { useStore } from "@/lib/store";

export default function LoginPage() {
  const { ready, user, login, loginWithSecret } = useStore();
  const router = useRouter();
  const [mode, setMode] = useState<"password" | "key">("password");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
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
    toast.success("Добро пожаловать в истройку");
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
    <div className="tk-stage relative flex min-h-screen items-center justify-center px-4 py-10">
      <div className="tk-window relative z-10 grid w-full max-w-5xl overflow-hidden rounded-[32px] border border-white/70 shadow-[0_24px_70px_rgba(46,58,90,0.16)] lg:grid-cols-[1.05fr_0.95fr]">
        <div className="tk-window-pane tk-glass-dark hidden flex-col justify-between p-10 text-white lg:flex">
          <div>
            <div className="mb-8">
              <Logo markClassName="h-12 w-12" titleClassName="text-2xl" />
            </div>
            <h1 className="font-[family-name:var(--font-display)] text-3xl leading-tight tracking-tight">
              Вход в личный кабинет
            </h1>
            <p className="mt-3 max-w-sm text-sm leading-relaxed text-white/75">
              Вход по email и паролю. Суперадмин и администратор также входят
              секретным ключом. Новую организацию можно создать через
              саморегистрацию.
            </p>
          </div>
        </div>

        <div className="tk-window-pane tk-glass p-6 sm:p-10">
          <div className="mb-8 lg:hidden">
            <Link href="/">
              <Logo tone="ink" titleClassName="text-xl" />
            </Link>
          </div>

          <form onSubmit={onSubmit} className="space-y-4">
            <div className="tk-glass-chip grid grid-cols-2 gap-1 rounded-full p-1">
              <button
                type="button"
                className={`rounded-full px-3 py-2 text-sm font-medium ${
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
                className={`rounded-full px-3 py-2 text-sm font-medium ${
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
              <div key="password" className="tk-swap space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="email">Email</Label>
                  <Input
                    id="email"
                    type="email"
                    autoComplete="username"
                    placeholder="name@company.ru"
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
              </div>
            ) : (
              <div key="key" className="tk-swap space-y-2">
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

          <div className="mt-4 flex flex-wrap items-center justify-between gap-2 text-sm">
            <Link
              href="/recover"
              className="text-[var(--tk-copper-deep)] hover:underline"
            >
              Восстановить пароль
            </Link>
            <Link
              href="/register"
              className="text-[var(--tk-copper-deep)] hover:underline"
            >
              Саморегистрация
            </Link>
            <Link href="/" className="text-[var(--tk-muted)] hover:underline">
              На главную
            </Link>
          </div>

        </div>
      </div>
    </div>
  );
}
