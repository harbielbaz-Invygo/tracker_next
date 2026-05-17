/**
 * Wrap restricted pages in this gate to render either:
 *   - The actual page (if allowed)
 *   - A friendly "sign in required" panel (if guest)
 *   - A "🚫 wrong role" panel (if signed in but not allowed)
 *
 * Mirrors `tracker_v1/auth.py`'s `render_inline_login` + role checks.
 */
import Link from "next/link";
import { auth } from "@/lib/auth";
import { canAccess, type Role, type ViewName } from "@/lib/access";

export default async function AccessGate({
  view, children,
}: {
  view: ViewName;
  children: React.ReactNode;
}) {
  // Public-mode escape hatch — set DISABLE_AUTH=true in Vercel to
  // bypass every gate while the auth flow is broken. TEMPORARY. Take
  // this flag off the moment NextAuth is working again. Logged so
  // it's obvious from runtime logs the gate is wide open.
  if (process.env.DISABLE_AUTH === "true") {
    // eslint-disable-next-line no-console
    console.warn(`[access-gate] DISABLE_AUTH=true → bypassing gate for view=${view}`);
    return <>{children}</>;
  }

  const session = await auth();
  const role: Role = ((session?.user as any)?.role ?? "guest") as Role;

  if (canAccess(view, role)) {
    return <>{children}</>;
  }

  if (role === "guest") {
    return (
      <div className="max-w-lg mx-auto mt-12 card">
        <h2 className="text-xl font-bold mb-2">🔐 Sign in to continue</h2>
        <p className="text-ink-600 text-sm mb-4">
          This view requires a sign-in. Once logged in, you'll be brought back here.
        </p>
        <Link
          href={`/login?callbackUrl=${encodeURIComponent("/" + view.toLowerCase().replace(/[^a-z0-9]+/g, "-"))}`}
          className="btn btn-primary w-full"
        >
          Sign in
        </Link>
      </div>
    );
  }

  return (
    <div className="max-w-lg mx-auto mt-12 card border-flame">
      <h2 className="text-xl font-bold mb-1">🚫 Restricted</h2>
      <p className="text-ink-600 text-sm">
        <span className="font-medium">{view}</span> is not available for your role
        (<code>{role}</code>). Switch accounts to continue.
      </p>
    </div>
  );
}
