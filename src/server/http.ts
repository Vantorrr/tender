import { NextResponse } from "next/server";
import { assertSection } from "@/server/acl";
import { getSessionUser } from "@/server/auth";
import { ensureReady } from "@/server/db";
import type { SectionKey, User } from "@/lib/types";

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

/** Auth + section ACL (server-side role matrix). Superadmin always passes. */
export async function withSection(
  req: Request,
  section: SectionKey,
  handler: (user: User) => Promise<NextResponse> | NextResponse
): Promise<NextResponse> {
  return withUser(req, async (user) => {
    assertSection(user, section);
    return handler(user);
  });
}

/** Pass if user has any of the listed sections (matryoshka: docs via zakupki). */
export async function withAnySection(
  req: Request,
  sections: SectionKey[],
  handler: (user: User) => Promise<NextResponse> | NextResponse
): Promise<NextResponse> {
  return withUser(req, async (user) => {
    if (user.role !== "superadmin") {
      const ok = sections.some((s) => {
        try {
          assertSection(user, s);
          return true;
        } catch {
          return false;
        }
      });
      if (!ok) {
        throw new Error(
          `Недостаточно прав для раздела «${sections.join("|")}»`
        );
      }
    }
    return handler(user);
  });
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
      message.includes("другой организации") ||
      message.includes("Недостаточно прав")
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
