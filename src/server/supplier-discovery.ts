import { completeJson } from "@/server/openrouter";

export type SupplierSearchCandidate = {
  name: string;
  website: string;
  email?: string;
  materials: string[];
  regionEvidence: string;
  evidence: string;
  sourceUrl: string;
};

const SYSTEM = `Ты ищешь реальных поставщиков строительных материалов в открытых источниках для российского подрядчика. Используй web search. Не выдумывай организации, сайты, адреса электронной почты, ассортимент или присутствие в регионе.
В результат включай только организации, для которых поисковый источник подтверждает поставку указанного материала. Email указывай только если он прямо опубликован на доступной странице; иначе email должен быть пустым. sourceUrl — точный URL страницы, подтверждающей сведения; не используй поисковую ссылку вместо первоисточника. Если подтверждений мало, верни пустой список. Не отправляй письма и не считай поисковую выдачу доказательством надёжности.
Верни только JSON: {"candidates":[{"name":"","website":"","email":"","materials":[""],"regionEvidence":"краткое подтверждение региона или доставки","evidence":"короткая подтверждённая выдержка/пересказ со страницы","sourceUrl":"https://..."}]}. Не более 5 кандидатов.`;

function safeUrl(value: unknown) {
  if (typeof value !== "string") return "";
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : "";
  } catch { return ""; }
}

export async function discoverMaterialSuppliers(input: { material: string; region: string; work?: string }): Promise<SupplierSearchCandidate[]> {
  const material = input.material.trim().slice(0, 180);
  const region = input.region.trim().slice(0, 120);
  if (!material || !region) throw new Error("Укажите материал и регион для поиска");
  const query = `Найди поставщиков материала «${material}» в регионе «${region}» или с подтверждённой доставкой в этот регион. Объект: ${input.work?.trim().slice(0, 120) || "строительный проект"}. Ищи сайты производителей и официальных дилеров. Для каждого кандидата укажи точный первоисточник, подтверждение ассортимента и региона; email только если он прямо опубликован.`;
  const raw = await completeJson(SYSTEM, query, 0, { webSearch: true });
  const parsed = JSON.parse(raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")) as { candidates?: unknown[] };
  const seen = new Set<string>();
  return (Array.isArray(parsed.candidates) ? parsed.candidates : []).flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object") return [];
    const row = candidate as Record<string, unknown>;
    const name = typeof row.name === "string" ? row.name.trim().slice(0, 180) : "";
    const website = safeUrl(row.website);
    const sourceUrl = safeUrl(row.sourceUrl);
    const evidence = typeof row.evidence === "string" ? row.evidence.trim().slice(0, 600) : "";
    const regionEvidence = typeof row.regionEvidence === "string" ? row.regionEvidence.trim().slice(0, 240) : "";
    const email = typeof row.email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row.email.trim())
      ? row.email.trim().toLowerCase() : undefined;
    const materials = Array.isArray(row.materials)
      ? row.materials.filter((item): item is string => typeof item === "string").map((item) => item.trim().slice(0, 120)).filter(Boolean).slice(0, 5)
      : [];
    const key = email || sourceUrl || name.toLocaleLowerCase("ru-RU");
    if (!name || !sourceUrl || !evidence || !materials.length || seen.has(key)) return [];
    seen.add(key);
    return [{ name, website: website || new URL(sourceUrl).origin, email, materials, regionEvidence, evidence, sourceUrl }];
  }).slice(0, 5);
}
