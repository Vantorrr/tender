import { createHash, randomBytes } from "node:crypto";
import { cookies, headers } from "next/headers";
import { getDb, readAppData } from "@/server/db";
import { config } from "@/server/config";
import { hashPassword, verifyPassword } from "@/server/passwords";
import type { User } from "@/lib/types";

export { hashPassword, verifyPassword };

export const SESSION_COOKIE = "tk_session";
export const TOKEN_HEADER = "authorization";

export function createSession(userId: string): string {
  const token = randomBytes(32).toString("hex");
  const expires = new Date(
    Date.now() + config.sessionDays * 24 * 60 * 60 * 1000
  ).toISOString();
  getDb()
    .prepare(
      "INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)"
    )
    .run(token, userId, expires);
  return token;
}

export function destroySession(token: string) {
  getDb().prepare("DELETE FROM sessions WHERE token = ?").run(token);
}

export function getUserIdByToken(
  token: string | undefined | null
): string | null {
  if (!token) return null;
  const row = getDb()
    .prepare("SELECT user_id, expires_at FROM sessions WHERE token = ?")
    .get(token) as { user_id: string; expires_at: string } | undefined;
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    destroySession(token);
    return null;
  }
  return row.user_id;
}

function userById(userId: string | null): User | null {
  if (!userId) return null;
  const data = readAppData();
  const user = data.users.find((u) => u.id === userId) ?? null;
  if (!user || user.blocked) return null;
  return user;
}

/** Extract bearer token from Authorization header value */
export function bearerFromHeader(value: string | null | undefined): string | null {
  if (!value) return null;
  const m = value.match(/^Bearer\s+(.+)$/i);
  return m?.[1]?.trim() || null;
}

export async function getSessionUser(req?: Request): Promise<User | null> {
  // 1) Explicit request Authorization
  if (req) {
    const fromReq = bearerFromHeader(req.headers.get("authorization"));
    const byBearer = userById(getUserIdByToken(fromReq));
    if (byBearer) return byBearer;
  }

  // 2) Incoming headers() Authorization (App Router)
  try {
    const h = await headers();
    const fromHeaders = bearerFromHeader(h.get("authorization"));
    const byBearer = userById(getUserIdByToken(fromHeaders));
    if (byBearer) return byBearer;
  } catch {
    /* headers() unavailable outside request */
  }

  // 3) Cookie session
  try {
    const jar = await cookies();
    const token = jar.get(SESSION_COOKIE)?.value;
    return userById(getUserIdByToken(token));
  } catch {
    return null;
  }
}

export function publicUser(user: User) {
  const {
    password: _p,
    secretKey: _s,
    secretKeyHash,
    hasSecretKey: _h,
    ...rest
  } = user;
  void _p;
  void _s;
  void _h;
  return { ...rest, hasSecretKey: Boolean(secretKeyHash) };
}

export function recoveryToken(email: string): string {
  return createHash("sha256")
    .update(`recover:${email}:tma361`)
    .digest("hex")
    .slice(0, 12);
}

export function sessionCookieOptions(maxAgeSeconds: number) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    path: "/",
    maxAge: maxAgeSeconds,
  };
}
