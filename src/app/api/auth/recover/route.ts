import { NextResponse } from "next/server";
import { recoveryToken } from "@/server/auth";
import { demoPasswordFor } from "@/server/demo-accounts";
import { ensureReady, readAppData } from "@/server/db";
import { handleRouteError } from "@/server/http";
import { getMailTransport, sendMail } from "@/server/mail";

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
    const generic = {
      message:
        "Если аккаунт с таким email существует, письмо с инструкцией уже отправлено.",
    };
    if (!user) {
      return NextResponse.json(generic);
    }

    const token = recoveryToken(user.email);
    const transport = getMailTransport();
    await sendMail({
      to: user.email,
      subject: "Восстановление доступа — истройка",
      text: [
        "Запрос на восстановление пароля.",
        `Код восстановления: ${token}`,
        "Если вы не запрашивали восстановление, проигнорируйте письмо.",
      ].join("\n"),
    });

    // Isolated/demo: reveal demo password + code only when MAIL_TRANSPORT is memory/console
    // (tests assert inbox). Never include secrets when SMTP is configured.
    const revealDemo = transport.id === "memory" || transport.id === "console";
    if (!revealDemo) {
      return NextResponse.json(generic);
    }

    const demo = demoPasswordFor(user.email);
    return NextResponse.json({
      message: `Инструкция отправлена на ${user.email} (транспорт: ${transport.id}).`,
      transport: transport.id,
      // Demo fixture only — production SMTP path above omits these fields.
      code: token,
      demoPasswordHint: demo ? "см. демо-учётку стенда" : null,
    });
  } catch (e) {
    return handleRouteError(e, "Ошибка восстановления");
  }
}
