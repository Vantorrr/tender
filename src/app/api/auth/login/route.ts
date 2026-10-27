import { NextResponse } from "next/server";
import {
  SESSION_COOKIE,
  createSession,
  publicUser,
  verifyPassword,
} from "@/server/auth";
import { readAppData } from "@/server/db";

export async function POST(req: Request) {
  const body = (await req.json()) as { email?: string; password?: string };
  const email = body.email?.trim().toLowerCase() ?? "";
  const password = body.password ?? "";
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
  const res = NextResponse.json({ user: publicUser(user) });
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 7,
  });
  return res;
}
