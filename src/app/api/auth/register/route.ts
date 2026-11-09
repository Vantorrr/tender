import { json, handleRouteError } from "@/server/http";
import { ensureReady } from "@/server/db";
import {
  joinOrganizationByCode,
  registerNewOrganization,
} from "@/server/repo";
import { getBootstrap } from "@/server/repo";
import { readAppData } from "@/server/db";

export async function POST(req: Request) {
  try {
    ensureReady();
    const body = (await req.json()) as {
      mode?: "create_org" | "join";
      orgName?: string;
      inn?: string;
      joinCode?: string;
      name?: string;
      email?: string;
      password?: string;
    };
    if (body.mode === "join") {
      const result = joinOrganizationByCode({
        joinCode: body.joinCode ?? "",
        name: body.name ?? "",
        email: body.email ?? "",
        password: body.password ?? "",
      });
      const user = readAppData().users.find((u) => u.id === result.userId)!;
      const boot = getBootstrap(user);
      return json({
        ...boot,
        token: result.token,
        joinCode: undefined,
        message:
          "Вы вступили в организацию с ролью «тендерный специалист». Повышение роли — только администратором.",
      });
    }
    if (body.mode === "create_org") {
      const result = registerNewOrganization({
        orgName: body.orgName ?? "",
        inn: body.inn ?? "",
        name: body.name ?? "",
        email: body.email ?? "",
        password: body.password ?? "",
      });
      const user = readAppData().users.find((u) => u.id === result.userId)!;
      const boot = getBootstrap(user);
      return json({
        ...boot,
        token: result.token,
        joinCode: result.joinCode,
        message:
          "Организация создана. Письма не отправляются — сохраните код вступления сами.",
      });
    }
    return json({ error: "Укажите mode: create_org или join" }, 400);
  } catch (e) {
    return handleRouteError(e);
  }
}
