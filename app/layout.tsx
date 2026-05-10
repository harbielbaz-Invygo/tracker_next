import "./globals.css";
import type { Metadata } from "next";
import { SessionProvider } from "next-auth/react";

export const metadata: Metadata = {
  title: "invygo · Uploading Vehicles Tracker",
  description: "Track the full vehicle onboarding journey — from partnership request to first customer delivery.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">
        <SessionProvider>{children}</SessionProvider>
      </body>
    </html>
  );
}
