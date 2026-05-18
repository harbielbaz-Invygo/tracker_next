/**
 * POST /api/admin/backfill-wave-actions — fill in missing wave-scope
 * actions on every existing wave.
 *
 * Why this exists: PR #144 (`feat(intake): auto-attach all wave-scope
 * actions`) made every new Intake attach the full wave-scope catalog
 * to each wave it creates. Waves that existed BEFORE that deploy (or
 * waves where the auto-attach query found zero wave-scope action_types
 * because `action_types.scope` hadn't been backfilled yet on this DB)
 * have empty VIN Chase sections in /action-center-v2.
 *
 * This route walks every wave, fetches every `action_types` row with
 * scope='wave', and inserts the missing combinations into the
 * scope-aware `actions` table. The (scope, scope_id, action_type_id)
 * UNIQUE constraint makes it idempotent — re-running is safe.
 *
 * GET — returns a dry-run report so admin can preview what would be
 *       attached without writing.
 * POST — performs the attach and returns the same shape with counts.
 *
 * Admin-only. Not linked from any UI by default; call manually:
 *   curl -X POST https://<host>/api/admin/backfill-wave-actions
 */
import { eq } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import {
  waves, actionTypes, actions as actionsTable,
} from "@/lib/db/schema";
import { computeExpectedDate } from "@/lib/expected-date";
import { requireAuth, apiError } from "@/lib/api-auth";

export const runtime = "nodejs";

interface BackfillReport {
  /** Total wave rows in DB. */
  wavesScanned: number;
  /** Count of action_types with scope='wave'. Zero means the Phase 1b
   *  backfill never ran on this DB — caller should run it first. */
  waveActionTypes: number;
  /** Names of wave-scope action_types, for the admin's sanity check. */
  waveActionTypeNames: string[];
  /** Rows inserted into `actions` (scope='wave') this run. */
  attached: number;
  /** Rows skipped because (scope, scope_id, action_type_id) already existed. */
  alreadyExisted: number;
  /** If anything threw, the first error message — diagnostic only. */
  firstError: string | null;
  /** True if this was a dry-run (GET) rather than a write (POST). */
  dryRun: boolean;
}

async function buildReport(write: boolean): Promise<BackfillReport> {
  const wavesRows = await db.select({
    id:               waves.id,
    availabilityDate: waves.availabilityDate,
  }).from(waves);

  const waveTypeRows = await db.select({
    id:                  actionTypes.id,
    name:                actionTypes.name,
    offsetDays:          actionTypes.offsetDays,
    offsetAnchor:        actionTypes.offsetAnchor,
    defaultDepartmentId: actionTypes.defaultDepartmentId,
  })
    .from(actionTypes)
    .where(eq(actionTypes.scope, "wave"));

  let attached = 0;
  let alreadyExisted = 0;
  let firstError: string | null = null;

  if (write && waveTypeRows.length > 0 && wavesRows.length > 0) {
    for (const w of wavesRows) {
      for (const at of waveTypeRows) {
        const expected = computeExpectedDate({
          anchor:     at.offsetAnchor,
          offsetDays: at.offsetDays,
          submission: w.availabilityDate, // best-effort fallback
          vin:        null,
          promised:   w.availabilityDate,
        });
        try {
          await db.insert(actionsTable).values({
            scope:        "wave",
            scopeId:      w.id,
            actionTypeId: at.id,
            departmentId: at.defaultDepartmentId ?? undefined,
            status:       "waiting",
            expectedDate: expected ?? undefined,
          });
          attached++;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (/UNIQUE constraint failed|already exists/i.test(msg)) {
            alreadyExisted++;
          } else {
            // First non-uniqueness error: capture and stop the inner
            // loop so we don't spam logs. Outer loop continues.
            if (!firstError) firstError = msg;
          }
        }
      }
    }
  }

  return {
    wavesScanned:         wavesRows.length,
    waveActionTypes:      waveTypeRows.length,
    waveActionTypeNames:  waveTypeRows.map((t) => t.name),
    attached,
    alreadyExisted,
    firstError,
    dryRun:               !write,
  };
}

export async function GET() {
  const gate = await requireAuth(["admin"]);
  if (!gate.ok) return gate.response;
  const report = await buildReport(false);
  return NextResponse.json({ ok: true, ...report });
}

export async function POST(_req: NextRequest) {
  const gate = await requireAuth(["admin"]);
  if (!gate.ok) return gate.response;
  try {
    const report = await buildReport(true);
    return NextResponse.json({ ok: true, ...report });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return apiError(`Backfill failed: ${msg}`, 500);
  }
}
