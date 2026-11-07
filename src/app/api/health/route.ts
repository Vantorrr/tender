import { NextResponse } from "next/server";
import { ensureReady } from "@/server/db";

export async function GET() {
  try {
    const snap = ensureReady();
    return NextResponse.json(snap);
  } catch (e) {
    return NextResponse.json(
      {
        ok: false,
        error: e instanceof Error ? e.message : "health failed",
      },
      { status: 500 }
    );
  }
}
