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
import type { User } from "@/lib/types";

function sessionResponse(user: User) {
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
}

function findBySecretKey(
  users: User[],
  secretKey: string
): User | undefined {
  const eligible = users.filter(
    (u) =>
      (u.role === "superadmin" || u.role === "admin") &&
      Boolean(u.secretKeyHash)
  );
  return eligible.find((u) => verifyPassword(secretKey, u.secretKeyHash ?? ""));
}

export async function POST(req: Request) {
  try {
    ensureReady();
    const body = (await req.json()) as {
      email?: string;
      password?: string;
      secretKey?: string;
    };
    const data = readAppData();
    const secretKey = body.secretKey?.trim() ?? "";
    if (secretKey) {
      if (secretKey.length < 8 || secretKey.length > 128) {
        return NextResponse.json(
          { error: "Неверный секретный ключ" },
          { status: 401 }
        );
      }
      const user = findBySecretKey(data.users, secretKey);
      if (!user) {
        return NextResponse.json(
          { error: "Неверный секретный ключ" },
          { status: 401 }
        );
      }
      if (user.blocked) {
        return NextResponse.json(
          { error: "Учётная запись заблокирована" },
          { status: 403 }
        );
      }
      return sessionResponse(user);
    }

    const email = body.email?.trim().toLowerCase() ?? "";
    const password = body.password ?? "";
    if (!email || !password) {
      return NextResponse.json(
        { error: "Укажите email и пароль или секретный ключ" },
        { status: 400 }
      );
    }
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
    return sessionResponse(user);
  } catch (e) {
    return handleRouteError(e, "Ошибка входа");
  }
}
