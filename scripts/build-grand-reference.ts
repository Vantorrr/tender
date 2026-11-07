import fs from "node:fs";
import path from "node:path";
import {
  analysisFromDrawing,
  analysisFromGrand,
  estimateKey,
  parseGrandBuffer,
} from "../src/server/grand-smeta";

const root = path.join(import.meta.dirname, "..");
const dir = path.join(root, "fixtures", "grand-smeta");

const files: { id: string; fixture: string; fileName: string; fileType: "xlsx" | "pdf" }[] = [
  {
    id: "d-gs-bur",
    fixture: "ls-02-02-01-burenie.xlsx",
    fileName: "ЛС-02-02-01-2023-бурение.xlsx",
    fileType: "xlsx",
  },
  {
    id: "d-gs-dem",
    fixture: "ls-01-02-01-demontazh.xlsx",
    fileName: "ЛС-01-02-01-2023-демонтаж.xlsx",
    fileType: "xlsx",
  },
  {
    id: "d-gs-dem2",
    fixture: "ls-01-02-01-demontazh-2.xlsx",
    fileName: "ЛС-01-02-01-2023-демонтаж-редакция-2.xlsx",
    fileType: "xlsx",
  },
  {
    id: "d-gs-svai",
    fixture: "ls-02-02-02-ustanovka.xlsx",
    fileName: "ЛС-02-02-02-2023-сваи.xlsx",
    fileType: "xlsx",
  },
  {
    id: "d-gs-znaki",
    fixture: "ls-02-02-04-ustanovka.xlsx",
    fileName: "ЛС-02-02-04-2023-знаки.xlsx",
    fileType: "xlsx",
  },
  {
    id: "d-gs-sneg",
    fixture: "ls-09-02-01.xlsx",
    fileName: "ЛС-09-02-01-2023-снег.xlsx",
    fileType: "xlsx",
  },
  {
    id: "d-gs-km",
    fixture: "III-D-101-3103-KM.L2_TP-KP-M-D_etap-2.pdf",
    fileName: "III-Д-101-3103-КМ.Л2_ТП-КП-М-Д_2 этап.pdf",
    fileType: "pdf",
  },
];

async function main() {
const built = [];
for (const file of files) {
  if (file.fileType === "pdf") {
    const analysis = analysisFromDrawing(file.fileName);
    built.push({ ...file, ...analysis, positions: [] });
    continue;
  }
  const parsed = await parseGrandBuffer(fs.readFileSync(path.join(dir, file.fixture)));
  if (!parsed) throw new Error(`Не разобрана смета ${file.fixture}`);
  const analysis = analysisFromGrand(parsed, file.fileName);
  const key = estimateKey(parsed.estimateNumber);
  built.push({
    ...file,
    ...analysis,
    positions: analysis.positions.map((position, index) => ({
      id: `${file.id}-p${index + 1}`,
      code: `${key} · ${position.code}`,
      name: position.name,
      unit: position.unit,
      quantity: position.quantity,
      rate: position.rate,
    })),
  });
}

const dem = built.filter((item) => item.analysis.estimateNumber.includes("ЛС 01-02-01"));
if (dem.length === 2) {
  const costs = dem
    .map((item) => item.analysis.costThousand)
    .filter((value): value is number => value != null)
    .sort((a, b) => a - b);
  for (const item of dem) {
    item.highlights.push({
      id: "h-dup",
      text: "Две редакции одного номера сметы",
      reason: `ЛС 01-02-01 встречается дважды: ${costs[0]} и ${costs[1]} тыс. руб. В расчёт объёмов взяты обе, с разными кодами.`,
      severity: "critical" as const,
      page: 1,
    });
    item.status = "trebuet_proverki";
    item.analyticalNote +=
      "\nВ комплекте две редакции ЛС 01-02-01 с разной сметной стоимостью. Это не округление: сверьте, какая редакция актуальна.";
  }
}

const nmck = built.reduce(
  (sum, item) => sum + (item.analysis.costThousand ?? 0) * 1000,
  0
);

const out = {
  nmck: Math.round(nmck * 100) / 100,
  documents: built.map(({ positions: _positions, ...doc }) => {
    void _positions;
    return doc;
  }),
  positions: built.flatMap((item) => item.positions),
};

const target = path.join(root, "src", "lib", "grand-reference.json");
fs.writeFileSync(target, JSON.stringify(out));
console.log(
  "docs",
  out.documents.length,
  "positions",
  out.positions.length,
  "nmck",
  out.nmck,
  "bytes",
  fs.statSync(target).size
);
}

main();
