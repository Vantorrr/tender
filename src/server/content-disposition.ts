/** Build a safe Content-Disposition value for both ASCII and Unicode names. */
export function contentDisposition(
  disposition: "inline" | "attachment",
  fileName: string
): string {
  const safeName = fileName
    .replace(/[\r\n\u0000-\u001f\u007f]/g, "")
    .replace(/[\\/]/g, "_")
    .trim() || "download";
  const asciiFallback = safeName
    .replace(/[^\x20-\x7e]/g, "_")
    .replace(/["\\]/g, "_");
  const encoded = encodeURIComponent(safeName).replace(
    /['()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  );
  return `${disposition}; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`;
}
