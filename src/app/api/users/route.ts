import {
  createUser,
  getBootstrap,
  setUserRole,
  setUserSections,
  updateUser,
} from "@/server/repo";
import { json, requireUser } from "@/server/http";
import type { Role, SectionKey, User } from "@/lib/types";
import { DEFAULT_SECTIONS } from "@/lib/roles";

export async function GET() {
  const auth = await requireUser();
  if ("error" in auth) return auth.error;
  return json({ items: getBootstrap(auth.user).data.users });
}

export async function POST(req: Request) {
  const auth = await requireUser();
  if ("error" in auth) return auth.error;
  if (auth.user.role !== "superadmin" && auth.user.role !== "admin") {
    return json({ error: "Недостаточно прав" }, 403);
  }
  const body = (await req.json()) as {
    name: string;
    email: string;
    password: string;
    role: Role;
  };
  createUser(auth.user.id, {
    name: body.name,
    email: body.email,
    password: body.password,
    role: body.role,
    orgId: auth.user.orgId,
    blocked: false,
    sections: DEFAULT_SECTIONS[body.role],
  });
  return json(getBootstrap(auth.user));
}

export async function PATCH(req: Request) {
  const auth = await requireUser();
  if ("error" in auth) return auth.error;
  if (auth.user.role !== "superadmin" && auth.user.role !== "admin") {
    return json({ error: "Недостаточно прав" }, 403);
  }
  const body = (await req.json()) as {
    id: string;
    patch?: Partial<User>;
    role?: Role;
    comment?: string;
    sections?: SectionKey[];
  };
  if (body.role) {
    setUserRole(auth.user.id, body.id, body.role, body.comment ?? "Изменение роли");
  } else if (body.sections) {
    setUserSections(auth.user.id, body.id, body.sections);
  } else if (body.patch) {
    updateUser(auth.user.id, body.id, body.patch);
  }
  return json(getBootstrap(auth.user));
}
