/**
 * Insights — the unified Dashboard + Reports view (proposal).
 *
 * Server component fetches everything in one round-trip (the data
 * layer parallelises internally) and hands the payload to the
 * client shell. Filters + Trust-tab selection are pure client state
 * inside the shell — no extra round-trips per interaction.
 *
 * Lives alongside the legacy /dashboard and /reports pages so the
 * operator can compare before retiring them.
 */
import InsightsShell from "@/components/insights-shell";
import { getInsightsData } from "@/lib/insights-data";

export const dynamic = "force-dynamic";

export default async function InsightsPage() {
  const data = await getInsightsData();
  return <InsightsShell data={data} />;
}
