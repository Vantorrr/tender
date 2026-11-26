export type DirectorySupplier = {
  name: string;
  email?: string;
  materialKeywords?: string[];
  regions?: string[];
  website?: string;
};

export const EXTERNAL_SUPPLIER_SEARCH =
  "Внешний поиск в интернете не подключён. Ищем только в справочнике поставщиков.";

export const NO_UNDO = "Отмены нет: верните значение вручную.";

function haystack(supplier: DirectorySupplier): string {
  return [
    supplier.name,
    supplier.email ?? "",
    ...(supplier.materialKeywords ?? []),
    ...(supplier.regions ?? []),
    supplier.website ?? "",
  ].join(" ").toLocaleLowerCase("ru-RU");
}

/** Live lookup in the company's supplier directory. No external web search. */
export function searchSupplierDirectory<T extends DirectorySupplier>(query: string, suppliers: T[]): T[] {
  const needle = query.trim().toLocaleLowerCase("ru-RU");
  if (needle.length < 2) return [];
  const tokens = needle.split(/[^a-zа-яё0-9]+/iu).filter((token) => token.length > 2);
  return suppliers.filter((supplier) => {
    const hay = haystack(supplier);
    if (hay.includes(needle)) return true;
    return (supplier.materialKeywords ?? []).some((keyword) => {
      const key = keyword.trim().toLocaleLowerCase("ru-RU");
      if (key.length < 2) return false;
      return needle.includes(key) || tokens.some((token) => key.includes(token) || token.includes(key));
    });
  });
}

export function collectSuppliersMessage(names: string[]): string {
  if (names.length === 0) {
    return "В справочнике подходящих поставщиков нет. Внешний поиск в интернете не подключён.";
  }
  return `В справочнике: ${names.join(", ")}. Внешний поиск в интернете не подключён.`;
}

export function gprNeedNextStep(material: string): string {
  return `Потребность «${material}» добавлена в список ниже. Дальше подберите поставщика из справочника и нажмите «Собрать».`;
}

/** Undo of the highlighted GPR need clears the path hint. Another row's hint stays. */
export function gprPathAfterUndo(
  path: { notice: string; highlightedId: string },
  undoneId: string,
): { notice: string; highlightedId: string } {
  if (!undoneId || path.highlightedId !== undoneId) return path;
  return { notice: "", highlightedId: "" };
}

/**
 * The old «никого не найдено» line is only for an empty external list
 * when the directory also has nobody. Directory matches already have their own note.
 */
export function showEmptyExternalSupplierLine(directoryCount: number, externalCount: number | null): boolean {
  return externalCount === 0 && directoryCount === 0;
}
