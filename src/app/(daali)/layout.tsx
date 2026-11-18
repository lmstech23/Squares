import { Inter, Lora } from "next/font/google";
import tokens from "@/components/daali/tokens.module.css";

// The layout for new Daali screens — Daali Slice 1, S1.3.
//
// CONTAINMENT. UI System 1.0 tokens and the Lora / Inter fonts are applied
// here, on a wrapper, and nowhere else. The root layout and globals.css are
// untouched, so every legacy page renders exactly as before. New pages opt in by
// living inside this (daali) route group.

const lora = Lora({ subsets: ["latin"], variable: "--daali-font-lora", display: "swap" });
const inter = Inter({ subsets: ["latin"], variable: "--daali-font-inter", display: "swap" });

export default function DaaliLayout({ children }: { children: React.ReactNode }) {
  return <div className={`${tokens.root} ${lora.variable} ${inter.variable}`}>{children}</div>;
}
