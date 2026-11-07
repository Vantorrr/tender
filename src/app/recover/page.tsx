"use client";

import Link from "next/link";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Logo } from "@/components/logo";
import { api } from "@/lib/api";

export default function RecoverPage() {
  const [step, setStep] = useState<"request" | "reset">("request");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  async function onRequest(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    try {
      const res = await api<{ message: string }>("/api/auth/recover", {
        method: "POST",
        body: JSON.stringify({ email, action: "request" }),
      });
      setMessage(res.message);
      setStep("reset");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Ошибка запроса");
    }
  }

  async function onReset(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    try {
      const res = await api<{ message: string }>("/api/auth/recover", {
        method: "POST",
        body: JSON.stringify({
          email,
          code,
          newPassword,
          action: "reset",
        }),
      });
      setMessage(res.message);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Ошибка сброса");
    }
  }

  return (
    <div className="relative flex min-h-screen items-center justify-center px-4 py-10">
      <div className="tk-window tk-glass relative z-10 w-full max-w-md rounded-[28px] p-8">
        <Link href="/">
          <Logo tone="ink" titleClassName="text-xl" />
        </Link>
        <h1 className="mt-6 font-[family-name:var(--font-display)] text-2xl tracking-tight">
          Восстановление пароля
        </h1>
        <p className="mt-2 text-sm text-[var(--tk-muted)]">
          {step === "request"
            ? "Укажите email — отправим одноразовый код на локальный почтовый sink / почту."
            : "Введите код из письма и новый пароль."}
        </p>
        {step === "request" ? (
          <form onSubmit={onRequest} className="mt-6 space-y-4">
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </div>
            <Button type="submit" className="w-full">
              Отправить код
            </Button>
          </form>
        ) : (
          <form onSubmit={onReset} className="mt-6 space-y-4">
            <div className="space-y-2">
              <Label htmlFor="code">Код из письма</Label>
              <Input
                id="code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                required
                autoComplete="one-time-code"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">Новый пароль</Label>
              <Input
                id="password"
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                required
                minLength={8}
              />
            </div>
            <Button type="submit" className="w-full">
              Сохранить пароль
            </Button>
            <button
              type="button"
              className="text-sm text-[var(--tk-copper-deep)] hover:underline"
              onClick={() => setStep("request")}
            >
              Запросить код снова
            </button>
          </form>
        )}
        {message ? (
          <p className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
            {message}
          </p>
        ) : null}
        {error ? (
          <p className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-900">
            {error}
          </p>
        ) : null}
        <Link
          href="/login"
          className="mt-6 inline-block text-sm text-[var(--tk-copper-deep)] hover:underline"
        >
          Вернуться ко входу
        </Link>
      </div>
    </div>
  );
}
