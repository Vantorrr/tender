import { NextResponse } from "next/server";
import { getSessionUser, publicUser } from "@/server/auth";
import { ensureReady } from "@/server/db";
import { handleRouteError } from "@/server/http";

export async function GET(req: Request) {
  try {
    ensureReady();
    const user = await getSessionUser(req);
    if (!user) return NextResponse.json({ user: null });
    return NextResponse.json({ user: publicUser(user) });
  } catch (e) {
    return handleRouteError(e, "Ошибка сессии");
  }
}
