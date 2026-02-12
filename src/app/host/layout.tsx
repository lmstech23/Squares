import { getHost } from "@/lib/auth";
import { redirect } from "next/navigation";
import HostNav from "./nav";

export default async function HostLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const host = await getHost();

  if (!host) {
    redirect("/login");
  }

  return (
    <div className="min-h-screen bg-gray-950 text-white">
      <HostNav email={host.email} />
      <main className="max-w-4xl mx-auto px-4 py-8">{children}</main>
    </div>
  );
}
