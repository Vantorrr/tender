import { NextResponse } from "next/server";
import {
  issueRecoveryCode,
  resetPasswordWithCode,
} from "@/server/auth";
import { ensureReady, readAppData } from "@/server/db";
import { handleRouteError } from "@/server/http";
import { getMailTransport, mailStatus, sendMail } from "@/server/mail";

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

    const status = mailStatus();
    const data = readAppData();
    const user = data.users.find((u) => u.email.toLowerCase() === email);

    // Issue+send only for existing unblocked users — response shape is identical
    // either way (no account enumeration / no mail-stack recon on this endpoint).
    if (user && !user.blocked) {
      const code = issueRecoveryCode(user.email);
      await sendMail({
        to: user.email,
        subject: "Восстановление доступа — истройка",
        text: [
          "Запрос на восстановление пароля.",
          `Код восстановления: ${code}`,
          "Код действует 30 минут. Если вы не запрашивали восстановление, проигнорируйте письмо.",
        ].join("\n"),
      });
      // Local debug only — never on prod.
      if (process.env.RECOVER_EXPOSE_CODE === "1" && getMailTransport().id !== "smtp") {
        return NextResponse.json({
          ...GENERIC,
          mailLive: status.live,
          ...(process.env.RECOVER_EXPOSE_CODE === "1" ? { code } : {}),
        });
      }
    }

    return NextResponse.json({
      ...GENERIC,
      mailLive: status.live,
    });
  } catch (e) {
    return handleRouteError(e, "Ошибка восстановления");
  }
}
