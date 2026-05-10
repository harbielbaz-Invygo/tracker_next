/**
 * POST /api/po-parse — parse a signed PO PDF into structured fields.
 *
 * Hardening:
 *   - Auth required (Ops or Admin). Mirrors the page-level access for Intake.
 *   - 10 MB upload cap (rejected before reading the body when the
 *     Content-Length header is honest, and again after for safety).
 *   - MIME and magic-byte (`%PDF`) checks reject obviously-bad uploads.
 *   - 20 s parser timeout to defend against PDF-bomb / ReDoS in `pdf-parse`.
 */
import { parsePoPdf } from "@/lib/po-parser-server";
import { requireAuth, apiError } from "@/lib/api-auth";

export const runtime = "nodejs"; // pdf-parse needs Node, not Edge
export const maxDuration = 30;   // seconds (Vercel/Node serverless)

const MAX_PDF_BYTES = 10 * 1024 * 1024; // 10 MB
const PARSE_TIMEOUT_MS = 20_000;

export async function POST(req: Request) {
  const gate = await requireAuth(["ops", "admin"]);
  if (!gate.ok) return gate.response;

  // Reject obvious size violations before reading the body. Honest clients
  // (browsers, curl) set Content-Length; spoofed values are caught below.
  const lengthHeader = req.headers.get("content-length");
  if (lengthHeader && Number(lengthHeader) > MAX_PDF_BYTES) {
    return apiError(`PDF must be ≤ ${MAX_PDF_BYTES / 1024 / 1024} MB`, 413);
  }

  try {
    const fd = await req.formData();
    const file = fd.get("pdf");
    if (!(file instanceof File)) {
      return apiError("No PDF file in 'pdf' field", 400);
    }
    if (file.size > MAX_PDF_BYTES) {
      return apiError(`PDF must be ≤ ${MAX_PDF_BYTES / 1024 / 1024} MB`, 413);
    }
    if (file.type && file.type !== "application/pdf") {
      return apiError("Only application/pdf is accepted", 415);
    }

    const buf = Buffer.from(await file.arrayBuffer());

    // Magic-byte check — guards against application/pdf MIME spoofing.
    if (buf.subarray(0, 4).toString("ascii") !== "%PDF") {
      return apiError("File is not a valid PDF (missing %PDF header)", 415);
    }

    // Wrap parser in a timeout — pdf-parse can run for minutes on a hostile PDF.
    const parsed = await Promise.race([
      parsePoPdf(buf),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`PDF parse exceeded ${PARSE_TIMEOUT_MS / 1000} s`)),
          PARSE_TIMEOUT_MS,
        ),
      ),
    ]);
    return Response.json(parsed);
  } catch (e) {
    return apiError(e instanceof Error ? e.message : String(e), 500);
  }
}
