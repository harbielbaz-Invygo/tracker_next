/**
 * Node-only PDF wrapper for the PO parser.
 *
 * Imports `pdf-parse` (which uses `fs`/`http`/`https` and therefore cannot
 * be bundled for the browser or the Edge runtime). The pure extraction
 * logic and types live in `./po-parser.ts` and stay safe for clients.
 *
 * Only import this file from API route handlers running on the Node
 * runtime (`export const runtime = "nodejs"`).
 */
import "server-only";
import { extract, type ParsedPO } from "./po-parser";

export async function parsePoPdf(buf: Buffer): Promise<ParsedPO> {
  const pdfParse = (await import("pdf-parse")).default;
  const data = await pdfParse(buf);
  return extract(data.text || "");
}
