import { NextResponse } from "next/server";
import {
  issueRecoveryCode,
  resetPasswordWithCode,
} from "@/server/auth";
import { ensureReady, readAppData } from "@/server/db";
import { handleRouteError } from "@/server/http";
import { getMailTransport, sendMail } from "@/server/mail";

const GENERIC = {
  message:
    "Если аккаунт с таким email существует, письмо с инструкцией уже отправлено.",
};

export async function POST(req: Request) {
  try {
    ensureReady();
    const body = (await req.json()) as {
      email?: string;
      code?: string;
      newPassword?: string;
      action?: "request" | "reset";
    };
    const email = body.email?.trim().toLowerCase() ?? "";
    if (!email) {
      return NextResponse.json({ error: "Укажите email" }, { status: 400 });
    }

    // Reset path: email + code + newPassword
    if (body.action === "reset" || (body.code && body.newPassword)) {
      const result = resetPasswordWithCode(
        email,
        body.code ?? "",
        body.newPassword ?? ""
      );
      if (!result.ok) {
        return NextResponse.json({ error: result.error }, { status: 400 });
      }
      return NextResponse.json({
        message: "Пароль обновлён. Войдите с новым паролем.",
        reset: true,
      });
    }

    const data = readAppData();
    const user = data.users.find((u) => u.email.toLowerCase() === email);
    if (!user || user.blocked) {
      return NextResponse.json(GENERIC);
    }

    const code = issueRecoveryCode(user.email);
    const transport = getMailTransport();
    await sendMail({
      to: user.email,
      subject: "Восстановление доступа — истройка",
      text: [
        "Запрос на восстановление пароля.",
        `Код восстановления: ${code}`,
        "Код действует 30 минут. Если вы не запрашивали восстановление, проигнорируйте письмо.",
      ].join("\n"),
    });

    // Local sinks may acknowledge transport id; never echo the code/password on SMTP.
    if (transport.id === "smtp") {
      return NextResponse.json(GENERIC);
    }

    return NextResponse.json({
      message: `Инструкция отправлена (транспорт: ${transport.id}).`,
      transport: transport.id,
      // Code is intentionally omitted from HTTP for file/memory — read mail sink / inbox in tests.
      // Exception: memory/console may expose code only when RECOVER_EXPOSE_CODE=1 (dev).
      ...(process.env.RECOVER_EXPOSE_CODE === "1" ? { code } : {}),
    });
  } catch (e) {
    return handleRouteError(e, "Ошибка восстановления");
  }
}
