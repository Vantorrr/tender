import { NextResponse } from "next/server";
import { recoveryToken } from "@/server/auth";
import { demoPasswordFor } from "@/server/demo-accounts";
import { readAppData } from "@/server/db";

export async function POST(req: Request) {
  const body = (await req.json()) as { email?: string };
  const email = body.email?.trim().toLowerCase() ?? "";
  const data = readAppData();
  const user = data.users.find((u) => u.email.toLowerCase() === email);
  if (!user) {
    return NextResponse.json({
      message:
        "Если аккаунт существует, письмо с инструкцией отправлено (мок).",
    });
  }
  const token = recoveryToken(user.email);
  const demo = demoPasswordFor(user.email);
  return NextResponse.json({
    message: `Письмо отправлено на ${user.email}. Демо-пароль: ${demo ?? "—"}. Код восстановления: ${token}`,
  });
}
