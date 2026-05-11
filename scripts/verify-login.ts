/**
 * One-off diagnostic — verify the seeded admin user exists in the
 * configured DATABASE_URL and that bcrypt accepts the demo password.
 *
 * Usage (PowerShell):
 *   $env:DATABASE_URL = "libsql://..."; $env:TURSO_AUTH_TOKEN = "..."; npx tsx scripts/verify-login.ts
 */
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import bcrypt from "bcryptjs";

async function main() {
  const all = await db.select().from(users);
  console.log(`Found ${all.length} users in DB.`);
  for (const u of all) {
    console.log(`  - ${u.username} (${u.role}) — hash starts with ${u.passwordHash.slice(0, 12)}…`);
  }
  const [admin] = await db.select().from(users).where(eq(users.username, "admin"));
  if (!admin) {
    console.error("❌ admin user not found");
    process.exit(1);
  }
  const ok = await bcrypt.compare("admin123", admin.passwordHash);
  console.log(`bcrypt.compare("admin123", admin.hash) = ${ok ? "✅" : "❌"}`);
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e);
  process.exit(1);
});
