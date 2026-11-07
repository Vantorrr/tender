import { NextResponse } from "next/server";
import { recoveryToken } from "@/server/auth";
import { demoPasswordFor } from "@/server/demo-accounts";
import { ensureReady, readAppData } from "@/server/db";
import { handleRouteError } from "@/server/http";

export async function POST(req: Request) {
  try {
    ensureReady();
    const body = (await req.json()) as { email?: string };
    const email = body.email?.trim().toLowerCase() ?? "";
    if (!email) {
      return NextResponse.json({ error: "Укажите email" }, { status: 400 });
    }
    const data = readAppData();
    const user = data.users.find((u) => u.email.toLowerCase() === email);
    if (!user) {
      return NextResponse.json({
        message:
          "Если аккаунт с таким email существует, письмо с инструкцией уже отправлено.",
      });
    }
    const token = recoveryToken(user.email);
    const demo = demoPasswordFor(user.email);
    return NextResponse.json({
      message: `Инструкция отправлена на ${user.email}. Временный пароль: ${demo ?? "—"}. Код: ${token}`,
    });
  } catch (e) {
    return handleRouteError(e, "Ошибка восстановления");
  }
}
