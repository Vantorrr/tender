import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import {
  SESSION_COOKIE,
  bearerFromHeader,
  destroySession,
  sessionCookieOptions,
} from "@/server/auth";
import { handleRouteError } from "@/server/http";

export async function POST(req: Request) {
  try {
    const jar = await cookies();
    const cookieToken = jar.get(SESSION_COOKIE)?.value;
    const bearer = bearerFromHeader(req.headers.get("authorization"));
    if (cookieToken) destroySession(cookieToken);
    if (bearer && bearer !== cookieToken) destroySession(bearer);
    const res = NextResponse.json({ ok: true });
    res.cookies.set(SESSION_COOKIE, "", {
      ...sessionCookieOptions(0),
      maxAge: 0,
    });
    return res;
  } catch (e) {
    return handleRouteError(e, "Ошибка выхода");
  }
}
