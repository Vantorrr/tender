import { getBootstrap, updateSchedule } from "@/server/repo";
import { withSection, json } from "@/server/http";
import type { GprSchedule } from "@/lib/types";

export async function GET(req: Request) {
  return withSection(req, "gpr", (user) =>
    json({ items: getBootstrap(user).data.schedules })
  );
}

export async function PATCH(req: Request) {
  return withSection(req, "gpr", async (user) => {
    const body = (await req.json()) as {
      id?: string;
      patch?: Partial<GprSchedule>;
    };
    if (!body.id || !body.patch) {
      return json({ error: "Нужны id и patch" }, 400);
    }
    updateSchedule(user.id, body.id, body.patch);
    return json(getBootstrap(user));
  });
}
