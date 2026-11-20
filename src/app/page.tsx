import Link from "next/link";
import { ArrowUpRight, Camera, Phone, Store } from "lucide-react";

export default function Home() {
  return (
    <main>
      <nav><a className="wordmark" href="/">shopcall<span>✳</span></a><span className="badge">Hackathon scaffold</span></nav>
      <section className="hero">
        <p className="eyebrow">Less admin. More making.</p>
        <h1>Your next storefront<br />starts with <em>hello.</em></h1>
        <p className="intro">Show your products. Tell your story. Get a storefront you can keep updated with another call.</p>
        <div className="notice"><Phone size={19} aria-hidden="true" /><span>Call screen is built; voice, saving, and publishing work once the backend routes are connected. Until then the app tells you what isn&apos;t available.</span></div>
        <div className="hero-actions">
          <Link className="btn primary big" href="/login"><Phone size={18} aria-hidden="true" /> Start a call</Link>
          <a className="text-link" href="https://github.com/karanpdx/Shopcall#readme">Build with the team <ArrowUpRight size={16} aria-hidden="true" /></a>
        </div>
      </section>
      <section className="steps" aria-label="Planned merchant journey">
        {[{ Icon: Phone, title: "Tell your story", text: "A conversation about your business, your style, and what makes it yours." }, { Icon: Camera, title: "Show what you make", text: "One product at a time. Photos, prices, and quantities you approve." }, { Icon: Store, title: "Open your storefront", text: "A real Replit storefront, with inventory you can update by voice." }].map(({ Icon, title, text }, i) => (
          <article key={title}><span className="step-number">0{i + 1}</span><Icon size={26} strokeWidth={1.4} aria-hidden="true" /><h2>{title}</h2><p>{text}</p></article>
        ))}
      </section>
      <footer><span>Made for people who make things.</span><span>Camera optional. Owner approval required.</span></footer>
    </main>
  );
}
