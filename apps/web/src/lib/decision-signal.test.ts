import { describe, expect, it } from "vitest";
import { parseDecisionSignal } from "./decision-signal";

describe("parseDecisionSignal", () => {
  it("parses failed and ok decision payloads", () => {
    expect(
      parseDecisionSignal(
        JSON.stringify({ type: "openconfer.decision", status: "failed", error: "HTTP 401" }),
      ),
    ).toEqual({ kind: "failed", error: "HTTP 401" });
    expect(parseDecisionSignal(JSON.stringify({ type: "openconfer.decision", status: "ok" }))).toEqual({
      kind: "ok",
      result: undefined,
      summary: undefined,
    });
  });

  it("parses preview payloads with result and summary", () => {
    expect(
      parseDecisionSignal(
        JSON.stringify({
          type: "openconfer.decision",
          status: "preview",
          result: { choice: "pizza" },
          summary: "Ordering pizza",
        }),
      ),
    ).toEqual({
      kind: "preview",
      result: { choice: "pizza" },
      summary: "Ordering pizza",
    });
  });

  it("parses ok payloads that include the saved result", () => {
    expect(
      parseDecisionSignal(
        JSON.stringify({
          type: "openconfer.decision",
          status: "ok",
          result: { approved: true },
          summary: "Go ahead",
        }),
      ),
    ).toEqual({
      kind: "ok",
      result: { approved: true },
      summary: "Go ahead",
    });
  });

  it("rejects preview without a result object", () => {
    expect(
      parseDecisionSignal(JSON.stringify({ type: "openconfer.decision", status: "preview" })),
    ).toBeNull();
    expect(
      parseDecisionSignal(
        JSON.stringify({ type: "openconfer.decision", status: "preview", result: "pizza" }),
      ),
    ).toBeNull();
  });

  it("ignores unrelated or invalid payloads", () => {
    expect(parseDecisionSignal('{"type":"other"}')).toBeNull();
    expect(parseDecisionSignal("not-json")).toBeNull();
    expect(parseDecisionSignal(new TextEncoder().encode("{}"))).toBeNull();
  });
});
