"use client"

import { useEffect, useState } from "react"
import { ArrowDown, ArrowRight, ArrowUpRight, Check, ClipboardCheck, Command, Menu, MessageCircle, Moon, Sparkles, Sun, Users, X } from "lucide-react"

const features = [
  { icon: MessageCircle, title: "Group chat", copy: "Talk with your team and tag @cohort anytime." },
  { icon: ClipboardCheck, title: "Task board", copy: "Paste your brief and get tasks, owners and due dates." },
  { icon: Check, title: "Check-ins", copy: "See what’s blocked or overdue in one message." },
  { icon: Users, title: "Contribution log", copy: "A fair record of who did what." },
]
const steps = ["Create a room", "Invite your teammates with a code", "Paste your brief and let @cohort build the board", "Track progress and finish on time"]

export default function LandingPage() {
  const [menuOpen, setMenuOpen] = useState(false)
  const [dark, setDark] = useState(false)

  useEffect(() => {
    const saved = localStorage.getItem("cohort-theme") === "dark"
    setDark(saved)
    document.documentElement.classList.toggle("dark", saved)
    const observer = new IntersectionObserver((entries) => entries.forEach((entry) => {
      if (entry.isIntersecting) { entry.target.classList.add("is-visible"); observer.unobserve(entry.target) }
    }), { threshold: 0.12 })
    document.querySelectorAll(".landing-reveal").forEach((item) => observer.observe(item))
    return () => observer.disconnect()
  }, [])

  const toggleTheme = () => {
    const next = !dark
    setDark(next)
    localStorage.setItem("cohort-theme", next ? "dark" : "light")
    document.documentElement.classList.toggle("dark", next)
  }

  return <main className="landing-page">
    <header className="landing-nav">
      <a className="landing-brand" href="/" aria-label="Cohort home"><span className="brand-mark"><MessageCircle size={20} fill="currentColor" /></span><span>cohort</span></a>
      <button className="landing-menu-toggle" onClick={() => setMenuOpen(!menuOpen)} aria-label={menuOpen ? "Close navigation menu" : "Open navigation menu"} aria-expanded={menuOpen}>{menuOpen ? <X /> : <Menu />}</button>
      <nav className={menuOpen ? "landing-links open" : "landing-links"} aria-label="Main navigation"><a href="#features" onClick={() => setMenuOpen(false)}>Features</a><a href="#how-it-works" onClick={() => setMenuOpen(false)}>How it works</a><a href="#about" onClick={() => setMenuOpen(false)}>About</a><div className="landing-nav-actions"><button className="landing-theme-toggle" onClick={toggleTheme} aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}>{dark ? <Sun size={16} /> : <Moon size={16} />}</button><a className="landing-signin" href="/join">Sign in</a><a className="landing-get-started" href="/join">Get started <ArrowRight size={15} /></a></div></nav>
    </header>

    <section className="landing-hero" id="about">
      <div className="hero-grid" aria-hidden="true" />
      <div className="hero-content">
        <p className="hero-label"><span /> For student group projects</p>
        <h1>Group projects,<br />finally<br /><span>under control.</span></h1>
        <p className="hero-copy">Cohort is the teammate in your group chat that turns your brief into tasks, owners and deadlines — and keeps everyone honest.</p>
        <div className="hero-actions"><a className="hero-primary" href="/join">Start a room <ArrowRight size={17} /></a><a className="hero-secondary" href="#how-it-works">See how it works <ArrowDown size={15} /></a></div>
        <div className="hero-proof"><div className="proof-avatars"><span>S</span><span>P</span><span>A</span></div><span>Made for teams that want to get it done</span></div>
      </div>
      <div className="hero-preview" aria-label="Preview of a Cohort project room">
        <div className="preview-window"><div className="preview-chrome"><span className="window-dots"><i /><i /><i /></span><span className="preview-url"><Command size={12} /> Campus Connect</span><span className="preview-status"><i /> Room live</span></div><div className="preview-app"><div className="preview-chat"><div className="preview-section-title"><span>THE CONVERSATION</span><strong>Team chat <small># general</small></strong></div><div className="preview-message"><b>S</b><span><strong>Sam</strong><small>Hey team, here’s the first pass at our plan.</small></span></div><div className="preview-message"><b className="purple">P</b><span><strong>Priya</strong><small>I’ll take the student interviews.</small></span></div><div className="preview-message bot"><b><Sparkles size={12} /></b><span><strong>@cohort <em>TEAM BOT</em></strong><small>I’ve turned the brief into a first-draft board.</small></span></div><div className="preview-input">Message your team… <span>↗</span></div></div><div className="preview-board"><div className="preview-section-title"><span>THE GAME PLAN</span><strong>Project board <small>5</small></strong></div><div className="preview-summary"><Sparkles size={14} /><span><b>PROJECT SNAPSHOT</b><small>A campus guide for new students.</small></span></div><div className="preview-columns">{[{ title: "To do", task: "Map the campus welcome journey", tag: "t2" }, { title: "In progress", task: "Interview first-year students", tag: "t1" }, { title: "Done", task: "Share concept with advisor", tag: "t5" }].map((column) => <div className="preview-column" key={column.title}><strong><i />{column.title}</strong><div className="preview-task"><small>{column.tag}</small><b>{column.task}</b><span>↗ &nbsp;Nov 20</span></div></div>)}</div><div className="preview-board-footer"><i /> Changes sync automatically</div></div></div></div>
      </div>
      <div className="hero-glow" aria-hidden="true" />
    </section>

    <section className="landing-features landing-section" id="features"><div className="section-heading landing-reveal"><p className="landing-eyebrow">LESS CHAOS, MORE PROGRESS</p><h2>Four tools. One finished project.</h2><p>Everything your group needs to go from “who’s doing what?” to done.</p></div><div className="feature-grid">{features.map(({ icon: Icon, title, copy }, index) => <article className="feature-card landing-reveal" key={title} style={{ transitionDelay: `${index * 70}ms` }}><span className="feature-icon"><Icon size={20} /></span><h3>{title}</h3><p>{copy}</p><span className="feature-number">0{index + 1}</span></article>)}</div></section>

    <section className="landing-how landing-section" id="how-it-works"><div className="section-heading landing-reveal"><p className="landing-eyebrow">A SIMPLE GAME PLAN</p><h2>From brief to done in 4 steps.</h2><p>Set your team up once. Spend the rest of your time making something great.</p></div><ol className="steps-timeline">{steps.map((step, index) => <li className="step-item landing-reveal" key={step} style={{ transitionDelay: `${index * 80}ms` }}><span className="step-number">0{index + 1}</span><span className="step-line" /><h3>{step}</h3></li>)}</ol></section>

    <section className="landing-cta landing-reveal"><div><p className="landing-eyebrow">YOUR TEAM’S NEXT BIG IDEA STARTS HERE</p><h2>Start your next group project<br />the easy way.</h2><p>One room to plan, share and get it over the finish line.</p></div><a href="/join">Create a room <ArrowRight size={17} /></a></section>
    <footer className="landing-footer"><a className="landing-brand" href="/" aria-label="Cohort home"><span className="brand-mark"><MessageCircle size={18} fill="currentColor" /></span><span>cohort</span></a><p>Less herding cats. More making things.</p><nav aria-label="Footer navigation"><a href="#features">Features</a><a href="#how-it-works">How it works</a><a href="/join">Get started <ArrowUpRight size={13} /></a></nav><span className="footer-copyright">© {new Date().getFullYear()} Cohort</span></footer>
  </main>
}
