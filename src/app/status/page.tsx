import type { Metadata } from "next";
import { Shell } from "../../features/call/components/Shell";
import { StatusView } from "../../features/call/components/StatusView";

export const metadata: Metadata = { title: "Storefront status — lit" };

export default async function StatusPage({ searchParams }: { searchParams: Promise<{ job?: string | string[] }> }) {
  const { job } = await searchParams;
  return <Shell><StatusView jobId={typeof job === "string" ? job : null} /></Shell>;
}
