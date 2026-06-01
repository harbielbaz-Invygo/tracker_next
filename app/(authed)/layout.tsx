/**
 * Authed layout — brand header + sidebar nav + main content area.
 * Mirrors `tracker_v1/dashboard.py`'s top-level structure.
 */
import { auth } from "@/lib/auth";
import BrandHeader from "@/components/brand-header";
import Sidebar from "@/components/sidebar";

export default async function AuthedLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();

  // Default values for guests (matches GUEST_USER in tracker_v1/auth.py)
  const role = (session?.user as any)?.role ?? "guest";
  const name = session?.user?.name ?? "Guest";
  const username = (session?.user as any)?.username ?? "guest";

  return (
    <div className="flex min-h-screen">
      <Sidebar role={role} name={name} username={username} />
      <main className="relative flex-1 px-8 py-6 max-w-screen-2xl">
        {/* Brand sits in the top-right corner of the content area so the
            page title (rendered by each page's PageHeader as the first
            child) rises to the top-left instead of sitting beneath a
            full-width brand block. pointer-events-none so the text
            overlay never intercepts clicks on header controls beneath
            it; the page subtitle sits on a lower line, so no overlap. */}
        <div className="pointer-events-none absolute right-8 top-6 z-10 hidden sm:block">
          <BrandHeader />
        </div>
        {children}
      </main>
    </div>
  );
}
