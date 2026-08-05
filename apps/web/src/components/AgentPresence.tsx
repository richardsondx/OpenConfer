export type AgentPresenceState = "waiting" | "joined" | "listening" | "speaking";

const LABELS: Record<AgentPresenceState, string> = {
  waiting: "Waiting for the agent…",
  joined: "Agent is here",
  listening: "Agent is listening",
  speaking: "Agent is speaking",
};

/** OpenAI-style presence orb for the speaking agent. */
export function AgentPresence({
  state,
  level = 0,
}: {
  state: AgentPresenceState;
  /** 0–1 speech energy used to scale the speaking pulse. */
  level?: number;
}) {
  const intensity = Math.min(1, Math.max(0, level));
  return (
    <div
      className={`agent-presence is-${state}`}
      role="img"
      aria-label={LABELS[state]}
      style={{ ["--agent-level" as string]: intensity.toFixed(3) }}
    >
      <div className="agent-presence-ring" aria-hidden="true" />
      <div className="agent-presence-ring agent-presence-ring-delay" aria-hidden="true" />
      <div className="agent-presence-orb" aria-hidden="true" />
      <p className="agent-presence-label">{LABELS[state]}</p>
    </div>
  );
}
