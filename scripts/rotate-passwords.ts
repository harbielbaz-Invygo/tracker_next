/**
 * One-off — rotate the demo `admin` and `ops1` passwords on the
 * configured DATABASE_URL. Run once after deploying to production
 * since the seeded passwords (`admin123` / `ops123`) are public
 * knowledge in the seed source.
 *
 * Usage (PowerShell):
 *   $env:DATABASE_URL = "libsql://…"
 *   $env:TURSO_AUTH_TOKEN = "…"
 *   $env:NEW_ADMIN_PW = "…"
 *   $env:NEW_OPS_PW   = "…"
 *   npx tsx scripts/rotate-passwords.ts
 *
 * Verifies bcrypt.compare for each new password before exiting so a
 * silent failure can't leave the table in a half-updated state.
 */
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import bcrypt from "bcryptjs";

async function rotate(username: string, newPassword: string) {
  const [user] = await db.select().from(users).where(eq(users.username, username));
  if (!user) throw new Error(`user "${username}" not found`);
  const hash = await bcrypt.hash(newPassword, 10);
  await db.update(users).set({ passwordHash: hash }).where(eq(users.id, user.id));
  // Verify by re-reading and comparing.
  const [after] = await db.select().from(users).where(eq(users.id, user.id));
  const ok = await bcrypt.compare(newPassword, after.passwordHash);
  if (!ok) throw new Error(`bcrypt round-trip failed for ${username}`);
  console.log(`  ✓ ${username} — new hash starts with ${after.passwordHash.slice(0, 12)}…`);
}

async function main() {
  const adminPw = process.env.NEW_ADMIN_PW;
  const opsPw   = process.env.NEW_OPS_PW;
  if (!adminPw || !opsPw) {
    console.error("Set NEW_ADMIN_PW and NEW_OPS_PW env vars.");
    process.exit(2);
  }
  console.log("Rotating passwords…");
  await rotate("admin", adminPw);
  await rotate("ops1",  opsPw);
  console.log("Done.");
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e);
  process.exit(1);
});
