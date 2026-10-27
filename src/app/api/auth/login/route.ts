import { NextResponse } from "next/server";
import {
  SESSION_COOKIE,
  createSession,
  publicUser,
  sessionCookieOptions,
  verifyPassword,
} from "@/server/auth";
import { ensureReady, readAppData } from "@/server/db";
import { handleRouteError } from "@/server/http";

export async function POST(req: Request) {
  try {
    ensureReady();
    const body = (await req.json()) as { email?: string; password?: string };
    const email = body.email?.trim().toLowerCase() ?? "";
    const password = body.password ?? "";
    if (!email || !password) {
      return NextResponse.json(
        { error: "Укажите email и пароль" },
        { status: 400 }
      );
    }
    const data = readAppData();
    const user = data.users.find((u) => u.email.toLowerCase() === email);
    if (!user || !verifyPassword(password, user.password ?? "")) {
      return NextResponse.json(
        { error: "Неверный email или пароль" },
        { status: 401 }
      );
    }
    if (user.blocked) {
      return NextResponse.json(
        { error: "Учётная запись заблокирована" },
        { status: 403 }
      );
    }
    const token = createSession(user.id);
    const res = NextResponse.json({
      user: publicUser(user),
      token,
    });
    res.cookies.set(
      SESSION_COOKIE,
      token,
      sessionCookieOptions(60 * 60 * 24 * 7)
    );
    return res;
  } catch (e) {
    return handleRouteError(e, "Ошибка входа");
  }
}
