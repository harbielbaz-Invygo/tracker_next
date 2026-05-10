/**
 * Settings — admin-only configuration.
 *
 * Server component:
 *   1. Loads the full editor state (departments + action types + deps + rules).
 *   2. Hands it to <SettingsShell> (client) which mutates via /api/settings.
 *
 * Access: Admin only (enforced by AccessGate; middleware kicks guests to /login).
 */
import AccessGate from "@/components/access-gate";
import SettingsShell from "@/components/settings-shell";
import { getSettingsData } from "@/lib/settings-data";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const data = await getSettingsData();

  return (
    <AccessGate view="Settings">
      <div>
        <h1 className="text-3xl font-bold mb-1">⚙️ Settings</h1>
        <p className="text-sm text-ink-500 mb-6 max-w-prose">
          Admin configuration. Departments, action types, and the dependency
          DAG are edited here. Changes apply immediately to new batches.
        </p>
        <SettingsShell data={data} />
      </div>
    </AccessGate>
  );
}
