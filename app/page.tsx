import { redirect } from "next/navigation";

/** Root → Dashboard. */
export default function Home() {
  redirect("/dashboard");
}
