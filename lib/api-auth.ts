/**
 * API route auth gate + uniform error helper.
 *
 * Every mutating route MUST start with `requireAuth(...)` because the
 * middleware deliberately bypasses `/api/*` (so it can return JSON 401
 * instead of redirecting to the login HTML page).
 *
 * Usage:
 *   const gate = await requireAuth(["ops", "admin"]);
 *   if (!gate.ok) return gate.response;
 *   const { user } = gate;
 */
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import type { Role } from "@/lib/access";

export type AuthOk   = { ok: true;  user: { id: string; username: string; role: Role } };
export type AuthFail = { ok: false; response: NextResponse };

export async function requireAuth(allowedRoles?: Role[]): Promise<AuthOk | AuthFail> {
  const session = await auth();
  const role = session?.user?.role;
  const username = session?.user?.username;

  if (!session?.user || !role || !username) {
    return { ok: false, response: apiError("Sign in required", 401) };
  }
  if (allowedRoles && !allowedRoles.includes(role)) {
    return { ok: false, response: apiError("Insufficient permissions", 403) };
  }
  return {
    ok: true,
    user: {
      id: String(session.user.id ?? ""),
      username,
      role,
    },
  };
}

/** Uniform error shape across the API. */
export function apiError(message: string, status = 500, extras?: Record<string, unknown>): NextResponse {
  return NextResponse.json({ error: message, ...extras }, { status });
}
