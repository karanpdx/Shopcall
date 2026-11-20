"use client";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { createApiClient } from "../api";
import { ConsentNotice } from "./ConsentNotice";

export function LoginForm() {
  const api = useMemo(() => createApiClient(), []);
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await api.login(email, password);
    setBusy(false);
    if (res.ok) router.push("/call");
    else setError(res.error.code === "UNAUTHORIZED" ? "That email and password don't match the demo owner account." : res.error.message);
  }

  return (
    <div className="auth-grid">
      <form className="panel auth-form" onSubmit={submit} aria-describedby={error ? "login-error" : undefined}>
        <h1 className="page-title">Sign in to your store</h1>
        <p className="muted">This demo uses one fixed owner account. Your teammates have the sign-in details.</p>
        <label className="field">
          <span>Email</span>
          <input type="email" autoComplete="username" required value={email} onChange={e => setEmail(e.target.value)} />
        </label>
        <label className="field">
          <span>Password</span>
          <input type="password" autoComplete="current-password" required value={password} onChange={e => setPassword(e.target.value)} />
        </label>
        {error && <p id="login-error" className="error" role="alert">{error}</p>}
        <button className="btn primary" type="submit" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
      </form>
      <section className="panel">
        <h2 className="panel-title">Before your call</h2>
        <ConsentNotice />
      </section>
    </div>
  );
}
