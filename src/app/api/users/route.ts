import {
  createUser,
  getBootstrap,
  issueSecretKey,
  setUserRole,
  setUserSections,
  updateUser,
} from "@/server/repo";
import { withSection, json } from "@/server/http";
import type { Role, SectionKey, User } from "@/lib/types";
import { DEFAULT_SECTIONS } from "@/lib/roles";

export async function GET(req: Request) {
  return withSection(req, "polzovateli", (user) =>
    json({ items: getBootstrap(user).data.users })
  );
}

export async function POST(req: Request) {
  return withSection(req, "polzovateli", async (user) => {
    if (user.role !== "superadmin" && user.role !== "admin") {
      return json({ error: "Недостаточно прав" }, 403);
    }
    const body = (await req.json()) as {
      name?: string;
      email?: string;
      password?: string;
      role?: Role;
    };
    if (!body.name || !body.email || !body.role) {
      return json({ error: "Укажите имя, email и роль" }, 400);
    }
    createUser(user.id, {
      name: body.name,
      email: body.email,
      password: body.password ?? "Demo123!",
      role: body.role,
      orgId: user.orgId,
      blocked: false,
      sections: DEFAULT_SECTIONS[body.role],
    });
    return json(getBootstrap(user));
  });
}

export async function PATCH(req: Request) {
  return withSection(req, "polzovateli", async (user) => {
    if (user.role !== "superadmin" && user.role !== "admin") {
      return json({ error: "Недостаточно прав" }, 403);
    }
    const body = (await req.json()) as {
      id?: string;
      patch?: Partial<User>;
      role?: Role;
      comment?: string;
      sections?: SectionKey[];
      action?: "issueSecretKey";
    };
    if (!body.id) return json({ error: "Не указан id" }, 400);
    if (body.action === "issueSecretKey") {
      const issued = issueSecretKey(user.id, body.id);
      return json({ ...getBootstrap(user), issuedSecretKey: issued.key });
    }
    if (body.role) {
      setUserRole(
        user.id,
        body.id,
        body.role,
        body.comment ?? "Изменение роли"
      );
    } else if (body.sections) {
      setUserSections(user.id, body.id, body.sections);
    } else if (body.patch) {
      updateUser(user.id, body.id, body.patch);
    } else {
      return json({ error: "Нет изменений" }, 400);
    }
    return json(getBootstrap(user));
  });
}
