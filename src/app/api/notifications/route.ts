import { getBootstrap, markNotificationRead } from "@/server/repo";
import { json, requireUser } from "@/server/http";

export async function PATCH(req: Request) {
  const auth = await requireUser();
  if ("error" in auth) return auth.error;
  const body = (await req.json()) as { id: string };
  markNotificationRead(auth.user.id, body.id);
  return json(getBootstrap(auth.user));
}
