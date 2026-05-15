/**
 * Inline login page — works as both the standalone /login route and as a
 * fallback when middleware redirects. Mirrors `render_inline_login()` in
 * `tracker_v1/auth.py`.
 */
"use client";

import { Suspense, useState } from "react";
import { signIn } from "next-auth/react";
import { useSearchParams, useRouter } from "next/navigation";

/**
 * Outer wrapper — Next 15 requires `useSearchParams` consumers to be
 * inside a Suspense boundary so the rest of the page can stream while
 * the search params resolve. The fallback matches the form's footprint
 * so layout doesn't shift on hydration.
 */
export default function LoginPage() {
  return (
    <Suspense fallback={<LoginShell />}>
      <LoginForm />
    </Suspense>
  );
}

function LoginForm() {
  const params = useSearchParams();
  const router = useRouter();
  const callbackUrl = params.get("callbackUrl") ?? "/insights";
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(formData: FormData) {
    setBusy(true);
    setError(null);
    const res = await signIn("credentials", {
      username: formData.get("username"),
      password: formData.get("password"),
      redirect: false,
    });
    setBusy(false);
    if (res?.error) {
      setError("Invalid credentials.");
    } else {
      // `callbackUrl` is read from a query param, so it's an arbitrary
      // runtime string — `router.push` with typedRoutes wants a known
      // route literal. Casting through `as never` opts out of the
      // type-narrowing without losing runtime safety (the same string
      // would be a valid URL for the browser navigation).
      router.push(callbackUrl as never);
      router.refresh();
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-ink-100 px-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-6">
          <span className="brand-wordmark text-[2.4rem] leading-none">invygo</span>
          <p className="text-ink-500 text-sm mt-1">Uploading Vehicles Tracker</p>
          <div className="h-0.5 w-14 bg-brand mx-auto mt-2 rounded" />
        </div>

        <div className="card">
          <h2 className="text-lg font-bold text-midnight mb-1">🔐 Sign in</h2>
          <p className="text-sm text-ink-500 mb-4">
            Use a demo account or your own credentials.
          </p>

          <form action={onSubmit} className="space-y-3">
            <div>
              <label className="text-xs font-medium text-ink-600 mb-1 block">
                Username
              </label>
              <input name="username" required className="input" placeholder="e.g. partner1" />
            </div>
            <div>
              <label className="text-xs font-medium text-ink-600 mb-1 block">
                Password
              </label>
              <input name="password" type="password" required className="input" />
            </div>
            <button type="submit" className="btn btn-primary w-full" disabled={busy}>
              {busy ? "Signing in…" : "Sign in"}
            </button>
            {error && (
              <p className="text-sm text-flame-dark bg-flame-pale border border-flame
                            px-3 py-2 rounded-md" role="alert">
                {error}
              </p>
            )}
          </form>

          <div className="mt-5 pt-4 border-t border-ink-200 text-xs text-ink-500 space-y-1">
            <p className="font-medium text-ink-600">Demo accounts (synthetic data):</p>
            <p><code className="text-midnight">admin</code> / <code className="text-midnight">admin123</code> · full access</p>
            <p><code className="text-midnight">ops1</code> / <code className="text-midnight">ops123</code> · Operations</p>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Suspense fallback — same shell as the form, but inert. Renders during
 * the brief moment before `useSearchParams` resolves on the client.
 */
function LoginShell() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-ink-100 px-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-6">
          <span className="brand-wordmark text-[2.4rem] leading-none">invygo</span>
          <p className="text-ink-500 text-sm mt-1">Uploading Vehicles Tracker</p>
          <div className="h-0.5 w-14 bg-brand mx-auto mt-2 rounded" />
        </div>
        <div className="card">
          <h2 className="text-lg font-bold text-midnight mb-1">🔐 Sign in</h2>
          <p className="text-sm text-ink-500">Loading…</p>
        </div>
      </div>
    </div>
  );
}
