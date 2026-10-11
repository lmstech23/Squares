import { redirect } from "next/navigation";

// /host is retired as a destination (Auth spec, "Retired destinations"): it
// sends everyone to Your Daali. /host/boards itself still opens for anyone who
// goes to it directly.
export default function HostPage() {
  redirect("/home");
}
