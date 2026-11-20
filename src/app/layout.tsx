import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Shopcall — Your storefront starts with a conversation",
  description: "Show your products. Tell your story. Keep your storefront updated with a call.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="en"><body>{children}</body></html>;
}
