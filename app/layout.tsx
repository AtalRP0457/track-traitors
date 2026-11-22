import type { Metadata, Viewport } from "next";
import { t } from "@/shared/strings";
import "./globals.css";

export const metadata: Metadata = {
  title: t("meta.title"),
  description: t("meta.tagline"),
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  themeColor: "#0b1d2a",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
