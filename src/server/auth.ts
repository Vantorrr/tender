import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { cookies, headers } from "next/headers";
import { getDb, mutateAppData, readAppData } from "@/server/db";
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

/** Deterministic legacy helper — prefer issueRecoveryCode for new resets. */
export function recoveryToken(email: string): string {
  return createHash("sha256")
    .update(`recover:${email}:tma361`)
    .digest("hex")
    .slice(0, 12);
}

function hashRecoveryCode(code: string): string {
  return createHash("sha256").update(`tma361-recover:${code}`).digest("hex");
}

/** Issue one-time recovery code (returned in plain only to mail transport). */
export function issueRecoveryCode(email: string, ttlMinutes = 30): string {
  const code = randomBytes(6).toString("hex");
  const expires = new Date(Date.now() + ttlMinutes * 60_000).toISOString();
  getDb()
    .prepare(
      `INSERT INTO recovery_tokens (email, token_hash, expires_at)
       VALUES (?, ?, ?)
       ON CONFLICT(email) DO UPDATE SET token_hash = excluded.token_hash, expires_at = excluded.expires_at, created_at = datetime('now')`
    )
    .run(email.toLowerCase(), hashRecoveryCode(code), expires);
  return code;
}

export function consumeRecoveryCode(email: string, code: string): boolean {
  const row = getDb()
    .prepare(
      "SELECT token_hash, expires_at FROM recovery_tokens WHERE email = ?"
    )
    .get(email.toLowerCase()) as
    | { token_hash: string; expires_at: string }
    | undefined;
  if (!row) return false;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    getDb().prepare("DELETE FROM recovery_tokens WHERE email = ?").run(email.toLowerCase());
    return false;
  }
  const expected = Buffer.from(row.token_hash, "hex");
  const actual = Buffer.from(hashRecoveryCode(code.trim()), "hex");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return false;
  }
  getDb().prepare("DELETE FROM recovery_tokens WHERE email = ?").run(email.toLowerCase());
  return true;
}

export function resetPasswordWithCode(
  email: string,
  code: string,
  newPassword: string
): { ok: true } | { ok: false; error: string } {
  if (!newPassword || newPassword.length < 8) {
    return { ok: false, error: "Пароль не короче 8 символов" };
  }
  if (!consumeRecoveryCode(email, code)) {
    return { ok: false, error: "Неверный или просроченный код" };
  }
  const data = readAppData();
  const user = data.users.find((u) => u.email.toLowerCase() === email.toLowerCase());
  if (!user) return { ok: false, error: "Пользователь не найден" };
  if (user.blocked) return { ok: false, error: "Учётная запись заблокирована" };
  mutateAppData((d) => {
    d.users = d.users.map((u) =>
      u.id === user.id ? { ...u, password: hashPassword(newPassword) } : u
    );
    d.auditLog.unshift({
      id: `aud-recover-${Date.now()}`,
      at: new Date().toISOString(),
      actorId: user.id,
      action: "update",
      entity: "user",
      entityId: user.id,
      detail: "Пароль восстановлен по коду из письма",
    });
    return d;
  });
  // Invalidate sessions for this user
  getDb().prepare("DELETE FROM sessions WHERE user_id = ?").run(user.id);
  return { ok: true };
}

export function sessionCookieOptions(maxAgeSeconds: number) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    path: "/",
    maxAge: maxAgeSeconds,
  };
}
