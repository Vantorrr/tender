import { NextResponse } from "next/server";
import { getSessionUser } from "@/server/auth";
import { ensureReady } from "@/server/db";
import type { User } from "@/lib/types";

export async function requireUser(
  req?: Request
): Promise<{ user: User } | { error: NextResponse }> {
  try {
    ensureReady();
    const user = await getSessionUser(req);
    if (!user) {
      return {
        error: NextResponse.json({ error: "Требуется вход" }, { status: 401 }),
      };
    }
    return { user };
  } catch (e) {
    console.error("[requireUser]", e);
    return {
      error: NextResponse.json(
        { error: "Ошибка авторизации" },
        { status: 500 }
      ),
    };
  }
}

/** Auth + DB ready + try/catch wrapper for route handlers */
export async function withUser(
  req: Request,
  handler: (user: User) => Promise<NextResponse> | NextResponse
): Promise<NextResponse> {
  try {
    const auth = await requireUser(req);
    if ("error" in auth) return auth.error;
    return await handler(auth.user);
  } catch (e) {
    return handleRouteError(e);
  }
}

export function json(data: unknown, status = 200) {
  return NextResponse.json(data, { status });
}

export function fileResponse(
  body: Buffer,
  filename: string,
  contentType: string
) {
  return new NextResponse(new Uint8Array(body), {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}

export function handleRouteError(e: unknown, fallback = "Ошибка сервера") {
  console.error("[api]", e);
  const message = e instanceof Error ? e.message : fallback;
  let status = 500;
  if (e instanceof Error) {
    if (message === "Требуется вход") status = 401;
    else if (
      message.startsWith("Нет доступа") ||
      message.includes("другой организации")
    )
      status = 403;
    else if (message.includes("не найден") || message.includes("не найдена"))
      status = 404;
    else if (
      message.includes("уже существует") ||
      message.includes("Укажите") ||
      message.includes("Не указан") ||
      message.includes("Нет изменений") ||
      message.includes("Некорректный")
    )
      status = 400;
  }
  return NextResponse.json({ error: message }, { status });
}
