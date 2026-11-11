import { json, withUser } from "@/server/http";
import { assertSection } from "@/server/acl";
import type { ProjectChatScreen } from "@/lib/types";
import { getProjectChat, sendProjectChatMessage } from "@/server/project-chat";

const SCREEN_SECTIONS: Record<ProjectChatScreen, "zakupki" | "raschety" | "gpr" | "proizvodstvo"> = {
  procurement: "zakupki",
  calculation: "raschety",
  gpr: "gpr",
  production: "proizvodstvo",
};

function isScreen(value: string | null): value is ProjectChatScreen {
  return value === "procurement" || value === "calculation" || value === "gpr" || value === "production";
}

export async function GET(req: Request) {
  return withUser(req, (user) => {
    const url = new URL(req.url);
    const procurementId = url.searchParams.get("procurementId") ?? "";
    const screen = url.searchParams.get("screen");
    if (!procurementId || !isScreen(screen)) return json({ error: "Нужны закупка и контекст чата" }, 400);
    assertSection(user, SCREEN_SECTIONS[screen]);
    return json(getProjectChat(user, procurementId));
  });
}

export async function POST(req: Request) {
  return withUser(req, async (user) => {
    const body = (await req.json()) as {
      procurementId?: string;
      screen?: string;
      message?: string;
    };
    const screen = body.screen;
    if (
      !body.procurementId ||
      (screen !== "procurement" && screen !== "calculation" && screen !== "gpr" && screen !== "production")
    ) {
      return json({ error: "Нужны закупка и контекст чата" }, 400);
    }
    assertSection(user, SCREEN_SECTIONS[screen]);
    try {
      const result = await sendProjectChatMessage(user, {
        procurementId: body.procurementId,
        screen,
        message: body.message ?? "",
      });
      return json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Не удалось ответить по закупке";
      const status = message.includes("не настроен") ? 503 : message.includes("превышать") || message === "Введите вопрос" ? 400 : 422;
      return json({ error: message }, status);
    }
  });
}
