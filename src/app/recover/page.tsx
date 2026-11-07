"use client";

import Link from "next/link";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Logo } from "@/components/logo";
import { useStore } from "@/lib/store";

export default function RecoverPage() {
  const { requestRecovery } = useStore();
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const result = await requestRecovery(email);
    setMessage(result.message);
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
          Укажите email учётной записи. В демо-режиме пароль показывается сразу.
        </p>
        <form onSubmit={onSubmit} className="mt-6 space-y-4">
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
            Отправить
          </Button>
        </form>
        {message ? (
          <p className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
            {message}
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
