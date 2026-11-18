import type { Metadata } from "next";
import { StartFlow } from "./start-flow";

export const metadata: Metadata = { title: "Create your Daali account" };

export default async function StartPage({ searchParams }: { searchParams: Promise<{ next?: string | string[] }> }) {
  const { next } = await searchParams;
  return <StartFlow next={typeof next === "string" ? next : null} />;
}
