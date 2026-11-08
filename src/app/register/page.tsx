"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Logo } from "@/components/logo";
import { api, setClientToken } from "@/lib/api";
import { useStore } from "@/lib/store";

export default function RegisterPage() {
  const router = useRouter();
  const { refresh } = useStore();
  const [mode, setMode] = useState<"create_org" | "join">("create_org");
  const [orgName, setOrgName] = useState("");
  const [inn, setInn] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [issuedCode, setIssuedCode] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");
    try {
      const res = await api<{
        token: string;
        joinCode?: string;
        message?: string;
      }>("/api/auth/register", {
        method: "POST",
        body: JSON.stringify({
          mode,
          orgName,
          inn,
          joinCode,
          name,
          email,
          password,
        }),
      });
      setClientToken(res.token);
      if (res.joinCode) setIssuedCode(res.joinCode);
      await refresh();
      toast.success(res.message ?? "Регистрация выполнена");
      if (!res.joinCode) router.push("/cabinet");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Ошибка регистрации");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="tk-stage relative flex min-h-screen items-center justify-center px-4 py-10">
      <div className="tk-window-pane tk-glass relative z-10 w-full max-w-lg rounded-[28px] border border-white/70 p-6 sm:p-8 shadow-[0_24px_70px_rgba(46,58,90,0.16)]">
        <Link href="/" className="mb-6 inline-block">
          <Logo tone="ink" titleClassName="text-xl" />
        </Link>
        <h1 className="font-[family-name:var(--font-display)] text-2xl">
          Саморегистрация
        </h1>
        <p className="mt-2 text-sm text-[var(--tk-muted)]">
          Создайте организацию (роль администратор ЛК, не суперадмин) или
          вступите по коду. Письма не отправляются — коды показываются в UI.
        </p>

        <div className="mt-4 flex gap-2">
          <Button
            type="button"
            variant={mode === "create_org" ? "default" : "outline"}
            size="sm"
            onClick={() => setMode("create_org")}
          >
            Новая организация
          </Button>
          <Button
            type="button"
            variant={mode === "join" ? "default" : "outline"}
            size="sm"
            onClick={() => setMode("join")}
          >
            Вступить по коду
          </Button>
        </div>

        {issuedCode ? (
          <div className="mt-6 rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-950">
            <p className="font-semibold">Код вступления для сотрудников</p>
            <p className="mt-2 font-mono text-lg tracking-wide">{issuedCode}</p>
            <p className="mt-2 text-xs">
              Сохраните код сами — SMTP выключен. Роль join — только «тендерный
              специалист», без эскалации привилегий.
            </p>
            <Button className="mt-4" onClick={() => router.push("/cabinet")}>
              Перейти в кабинет
            </Button>
          </div>
        ) : (
          <form className="mt-6 space-y-3" onSubmit={onSubmit}>
            {mode === "create_org" ? (
              <>
                <div>
                  <Label htmlFor="org">Организация</Label>
                  <Input
                    id="org"
                    value={orgName}
                    onChange={(e) => setOrgName(e.target.value)}
                    required
                  />
                </div>
                <div>
                  <Label htmlFor="inn">ИНН</Label>
                  <Input
                    id="inn"
                    value={inn}
                    onChange={(e) => setInn(e.target.value)}
                    required
                  />
                </div>
              </>
            ) : (
              <div>
                <Label htmlFor="join">Код вступления</Label>
                <Input
                  id="join"
                  value={joinCode}
                  onChange={(e) => setJoinCode(e.target.value)}
                  required
                />
              </div>
            )}
            <div>
              <Label htmlFor="name">Ваше имя</Label>
              <Input
                id="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
              />
            </div>
            <div>
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </div>
            <div>
              <Label htmlFor="password">Пароль (≥8)</Label>
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={8}
              />
            </div>
            {error ? (
              <p className="text-sm text-rose-700" role="alert">
                {error}
              </p>
            ) : null}
            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? "Сохранение…" : "Зарегистрироваться"}
            </Button>
          </form>
        )}

        <p className="mt-6 text-center text-sm text-[var(--tk-muted)]">
          Уже есть аккаунт?{" "}
          <Link className="underline" href="/login">
            Войти
          </Link>
        </p>
      </div>
    </div>
  );
}
