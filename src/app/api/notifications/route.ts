import { getBootstrap, markNotificationRead } from "@/server/repo";
import { withUser, json } from "@/server/http";

export async function GET(req: Request) {
  return withUser(req, (user) =>
    json({ items: getBootstrap(user).data.notifications })
  );
}

export async function PATCH(req: Request) {
  return withUser(req, async (user) => {
    const body = (await req.json()) as { id?: string };
    if (!body.id) return json({ error: "Не указан id" }, 400);
    markNotificationRead(user.id, body.id);
    return json(getBootstrap(user));
  });
}
