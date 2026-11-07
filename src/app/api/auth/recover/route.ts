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

    // Honest status when outbound mail is not live — never invent SMTP or leak codes.
    if (!status.live) {
      // Still issue+sink locally for file/memory so isolated tests work, but API stays safe.
      if (user && !user.blocked) {
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
        // Never echo recovery codes. Local sinks only acknowledge transport id.
        if (transport.id === "smtp") {
          return NextResponse.json(GENERIC);
        }
        return NextResponse.json({
          message: `Почта не боевая (транспорт: ${transport.id}). Письма людям не уходят.`,
          transport: transport.id,
          mailLive: false,
          missing: status.missing,
          // Code only when explicitly enabled for local debug — never on prod.
          ...(process.env.RECOVER_EXPOSE_CODE === "1" ? { code } : {}),
        });
      }
      return NextResponse.json({
        ...GENERIC,
        mailLive: false,
        transport: status.transport,
        missing: status.missing,
      });
    }

    if (!user || user.blocked) {
      return NextResponse.json({ ...GENERIC, mailLive: true });
    }

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

    // Live SMTP: never echo code/password.
    return NextResponse.json({ ...GENERIC, mailLive: true, transport: "smtp" });
  } catch (e) {
    return handleRouteError(e, "Ошибка восстановления");
  }
}
