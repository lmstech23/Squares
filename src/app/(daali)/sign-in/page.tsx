import type { Metadata } from "next";
import { SignInFlow } from "./sign-in-flow";

export const metadata: Metadata = { title: "Sign in to Daali" };

export default async function SignInPage({ searchParams }: { searchParams: Promise<{ next?: string | string[] }> }) {
  const { next } = await searchParams;
  return <SignInFlow next={typeof next === "string" ? next : null} />;
}
