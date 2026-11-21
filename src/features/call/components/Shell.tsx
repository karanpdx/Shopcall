import Link from "next/link";

export function Shell({ children, label }: { children: React.ReactNode; label?: string }) {
  return (
    <main>
      <nav><Link className="wordmark" href="/">lit<span>✳</span></Link>{label && <span className="badge">{label}</span>}</nav>
      <div className="app-body">{children}</div>
    </main>
  );
}
