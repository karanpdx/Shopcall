import type { Metadata } from "next";
import { CallScreen } from "../../features/call/components/CallScreen";
import { Shell } from "../../features/call/components/Shell";

export const metadata: Metadata = { title: "Call — Shopcall" };

export default function CallPage() {
  return <Shell><CallScreen /></Shell>;
}
