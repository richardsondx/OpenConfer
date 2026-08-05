import { Button, ContinuityMark } from "./primitives";

const harnessLogos = {
  hermes: "https://hermes-agent.nousresearch.com/icon.png?icon.160vfo.zgihhn.png",
  openclaw: "https://openclaw.ai/favicon.svg",
  chatgpt: "https://www.google.com/s2/favicons?domain=chatgpt.com&sz=128",
  codex: "https://www.google.com/s2/favicons?domain=chatgpt.com&sz=128",
  claude:
    "https://cdn.prod.website-files.com/67ce28cfec624e2b733f8a52/681d52619fec35886a7f1a70_favicon.png",
} as const;

function HarnessMark({ name }: { name: keyof typeof harnessLogos | "custom" }) {
  if (name !== "custom") {
    return (
      <img
        className="integration-brand-logo"
        src={harnessLogos[name]}
        alt=""
        width="32"
        height="32"
        loading="lazy"
        referrerPolicy="no-referrer"
      />
    );
  }

  return (
    <svg viewBox="0 0 36 36" aria-hidden="true">
      <path d="M8 13h20v15H8zM13 13V9h10v4M13 19h.1M23 19h.1M13 24h10M4 18h4M28 18h4" />
    </svg>
  );
}

export function LandingHero() {
  const moveToSetup = () => {
    document.getElementById("get-started")?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <section className="landing-hero" aria-labelledby="landing-hero-title">
      <div className="landing-hero-copy">
        <p className="landing-eyebrow">
          <span className="landing-eyebrow-pulse" aria-hidden="true" />
          Human Decision Infrastructure
        </p>
        <h2 id="landing-hero-title">
          Give every AI agent
          <br />
          a way to <em>call you.</em>
        </h2>
        <p className="landing-lead">
          OpenConfer plugs into agent harnesses through skills, hooks, APIs, CLI, and MCP,
          so your AI agents can call you like an assistant, talk through decisions, and continue
          working with your answer.
        </p>
        <p className="landing-integrations-proof">
          Designed for Hermes, OpenClaw, ChatGPT, Codex, Claude Code, and custom agent harnesses.
        </p>
        <div className="landing-hero-actions">
          <Button type="button" onClick={moveToSetup}>
            Get started
            <span aria-hidden="true">→</span>
          </Button>
          <Button type="button" variant="secondary" onClick={moveToSetup}>
            Run it locally
          </Button>
        </div>
        <p className="landing-proof">
          <span aria-hidden="true">●</span> Open source · self-hosted · built for any agent harness
        </p>
      </div>

      <div className="decision-loop" aria-label="An agent calls a human for a decision, then resumes work">
        <div className="decision-loop-grid" aria-hidden="true" />
        <div className="decision-loop-label">LIVE DECISION LOOP</div>

        <div className="decision-card decision-card-agent">
          <div className="decision-card-meta">
            <span className="decision-status-dot" />
            AGENT WAITING
          </div>
          <strong>Can I ship this change?</strong>
          <span>Blocked on human judgment</span>
        </div>

        <div className="decision-call-path" aria-hidden="true">
          <span />
          <span />
          <span />
          <span />
          <span />
        </div>

        <div className="decision-human">
          <div className="decision-human-ring" aria-hidden="true" />
          <div className="decision-human-core">
            <ContinuityMark className="decision-human-mark" />
          </div>
          <span>YOU</span>
        </div>

        <div className="decision-card decision-card-answer">
          <div className="decision-card-meta">DECISION RETURNED</div>
          <strong>Ship behind the flag.</strong>
          <span>Agent resumed · just now</span>
        </div>

        <div className="decision-loop-caption">
          <span>Agent pauses</span>
          <i aria-hidden="true">→</i>
          <span>You decide by voice</span>
          <i aria-hidden="true">→</i>
          <span>Agent resumes</span>
        </div>
      </div>

      <div className="integration-rail" aria-label="Designed agent harnesses">
        <span className="integration-rail-label">DESIGNED FOR THE AGENTS YOU ALREADY USE</span>
        <span className="integration-brand integration-brand-hermes">
          <HarnessMark name="hermes" />
          <span className="integration-brand-name">Hermes</span>
          <span className="integration-brand-status">Available now</span>
        </span>
        <span className="integration-brand integration-brand-openclaw">
          <HarnessMark name="openclaw" />
          <span className="integration-brand-name">OpenClaw</span>
        </span>
        <span className="integration-brand integration-brand-chatgpt">
          <HarnessMark name="chatgpt" />
          <span className="integration-brand-name">ChatGPT</span>
          <span className="integration-brand-by">OpenAI</span>
        </span>
        <span className="integration-brand integration-brand-codex">
          <HarnessMark name="codex" />
          <span className="integration-brand-name">Codex</span>
          <span className="integration-brand-by">OpenAI</span>
        </span>
        <span className="integration-brand integration-brand-claude">
          <HarnessMark name="claude" />
          <span className="integration-brand-name">Claude Code</span>
          <span className="integration-brand-by">Anthropic</span>
        </span>
        <span className="integration-brand integration-brand-custom">
          <HarnessMark name="custom" />
          <span className="integration-brand-name">Custom agents</span>
        </span>
      </div>
    </section>
  );
}
