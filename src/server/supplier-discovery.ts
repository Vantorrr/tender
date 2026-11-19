import { SUPPLIER_DISCOVERY_SYSTEM } from "@/server/ai-prompts";
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

const SYSTEM = SUPPLIER_DISCOVERY_SYSTEM;

export function buildSupplierQuery(input: { material: string; region: string; work?: string }): string {
  const material = input.material.trim().slice(0, 180);
  const region = input.region.trim().slice(0, 120);
  return `Найди поставщиков материала «${material}» с подтверждённой поставкой в регион «${region}» или с доставкой туда. Объект: ${input.work?.trim().slice(0, 180) || "строительный проект"}. Для Крайнего Севера ищи подтверждение пути: Дудинка, Енисей, зимник, вахта. У каждого кандидата нужен первоисточник, подтверждение ассортимента и региона. Адрес почты — только если он прямо опубликован.`;
}

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
  const query = buildSupplierQuery(input);
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
