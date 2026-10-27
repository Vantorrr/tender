import { createHash, randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { getDb, readAppData } from "@/server/db";
import { config } from "@/server/config";
import { hashPassword, verifyPassword } from "@/server/passwords";
import type { User } from "@/lib/types";

export { hashPassword, verifyPassword };

export const SESSION_COOKIE = "tk_session";

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

export async function getSessionUser(): Promise<User | null> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  const userId = getUserIdByToken(token);
  if (!userId) return null;
  const data = readAppData();
  const user = data.users.find((u) => u.id === userId) ?? null;
  if (!user || user.blocked) return null;
  return user;
}

export function publicUser(user: User) {
  const { password: _p, ...rest } = user;
  void _p;
  return rest;
}

export function recoveryToken(email: string): string {
  return createHash("sha256")
    .update(`recover:${email}:tma361`)
    .digest("hex")
    .slice(0, 12);
}
