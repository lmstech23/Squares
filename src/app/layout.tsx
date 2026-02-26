import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Daali Boards",
  description: "Your boards. Your community. Zero chaos.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
