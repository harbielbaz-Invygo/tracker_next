/**
 * Intake — the main Post-PO workflow.
 *
 * Server component:
 *   1. Loads form options (departments / action types / dependencies / dealers).
 *   2. Hands them to <IntakeForm> (client) which drives the entire flow.
 *
 * The form:
 *   1. Drop signed PO PDF
 *   2. Edit PO header
 *   3. Edit Items × Splits
 *   4. Pick actions + assign departments
 *   5. Submit → /api/intake/create → success summary
 *
 * Each (item × split) becomes one batch; each picked action becomes a
 * batch_action per batch, with dependency-aware initial status.
 *
 * Access: Ops + Admin (enforced by middleware).
 */
import IntakeForm from "@/components/intake-form";
import PageHeader from "@/components/page-header";
import { getIntakeOptions } from "@/lib/intake-data";

export const dynamic = "force-dynamic";

export default async function IntakePage() {
  const options = await getIntakeOptions();
  return (
    <div>
      <PageHeader
        view="Intake"
        subtitle={<>Drop a signed PO PDF. Fields below auto-fill so Ops doesn&apos;t retype anything. Pick the actions this batch needs and assign each to a department.</>}
      />
      <IntakeForm options={options} />
    </div>
  );
}
