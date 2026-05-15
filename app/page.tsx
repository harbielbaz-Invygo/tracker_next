import { redirect } from "next/navigation";

/** Root → Insights (the unified leadership view). */
export default function Home() {
  redirect("/insights");
}
