import { NextResponse } from "next/server";
import { getSessionUser } from "@/server/auth";
import type { User } from "@/lib/types";

export async function requireUser(): Promise<
  { user: User } | { error: NextResponse }
> {
  const user = await getSessionUser();
  if (!user) {
    return {
      error: NextResponse.json({ error: "Требуется вход" }, { status: 401 }),
    };
  }
  return { user };
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
