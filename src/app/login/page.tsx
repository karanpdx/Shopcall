import type { Metadata } from "next";
import { LoginForm } from "../../features/call/components/LoginForm";
import { Shell } from "../../features/call/components/Shell";

export const metadata: Metadata = { title: "Sign in — Shopcall" };

export default function LoginPage() {
  return <Shell label="Demo owner"><LoginForm /></Shell>;
}
