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
import { auth } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  // Pull data + the current session in parallel — the session's user id
  // is what the Users editor uses to disable self-destructive actions
  // (you can't delete your own row or demote yourself out of admin).
  const [data, session] = await Promise.all([getSettingsData(), auth()]);
  const currentUserId = session?.user?.id ? Number(session.user.id) : null;

  return (
    <AccessGate view="Settings">
      <div>
        <h1 className="text-3xl font-bold mb-1">⚙️ Settings</h1>
        <p className="text-sm text-ink-500 mb-6 max-w-prose">
          Admin configuration. Departments, action types, dependency DAG, and
          user accounts live here. Changes apply immediately.
        </p>
        <SettingsShell data={data} currentUserId={currentUserId} />
      </div>
    </AccessGate>
  );
}
