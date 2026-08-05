import { fireEvent, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { DecisionTray, type JsonSchema, validateDecisionResult } from "./DecisionTray";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../../../");
const approval = JSON.parse(readFileSync(join(root, "examples/approval-checkpoint/session.json"), "utf8"));
const standup = JSON.parse(readFileSync(join(root, "examples/daily-standup/session.json"), "utf8"));
const decision = JSON.parse(readFileSync(join(root, "examples/decision-session/session.json"), "utf8"));

const schema = {
  type: "object",
  required: ["choice", "approved", "count"],
  properties: {
    choice: { type: "string", title: "Release choice", enum: ["ship", "hold"] },
    approved: { type: "boolean", title: "Approved" },
    count: { type: "integer", title: "Replica count" },
    tags: { type: "array", title: "Tags", items: { type: "string" } },
    limits: {
      type: "object",
      title: "Limits",
      required: ["budget"],
      properties: { budget: { type: "number", title: "Budget" } },
    },
  },
} as const;

describe("DecisionTray", () => {
  it("renders schema fields and reports required errors accessibly", () => {
    const confirm = vi.fn();
    render(<DecisionTray schema={schema} onConfirm={confirm} />);

    fireEvent.click(screen.getByRole("button", { name: /confirm and return/i }));

    expect(confirm).not.toHaveBeenCalled();
    expect(screen.getAllByText("This field is required.").length).toBeGreaterThanOrEqual(3);
    expect(screen.getByLabelText(/release choice/i)).toHaveAttribute("aria-invalid", "true");
  });

  it("returns typed primitive arrays and nested object values", () => {
    const confirm = vi.fn();
    render(<DecisionTray schema={schema} onConfirm={confirm} />);

    fireEvent.change(screen.getByLabelText(/release choice/i), { target: { value: "ship" } });
    fireEvent.change(screen.getByLabelText(/approved/i), { target: { value: "true" } });
    fireEvent.change(screen.getByLabelText(/replica count/i), { target: { value: "3" } });
    fireEvent.change(screen.getByLabelText(/tags/i), { target: { value: "safe\nreviewed" } });
    fireEvent.change(screen.getByLabelText(/budget/i), { target: { value: "12.5" } });
    fireEvent.click(screen.getByRole("button", { name: /confirm and return/i }));

    expect(confirm).toHaveBeenCalledWith({
      choice: "ship",
      approved: true,
      count: 3,
      tags: ["safe", "reviewed"],
      limits: { budget: 12.5 },
    }, "");
  });

  it("edits arrays of objects without raw JSON", () => {
    const confirm = vi.fn();
    render(
      <DecisionTray
        schema={{
          type: "object",
          required: ["entries"],
          properties: {
            entries: {
              type: "array",
              title: "Entries",
              minItems: 1,
              items: {
                type: "object",
                required: ["label"],
                properties: { label: { type: "string", title: "Label" } },
              },
            },
          },
        }}
        onConfirm={confirm}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /add item/i }));
    fireEvent.change(screen.getByLabelText(/^label/i), { target: { value: "alpha" } });
    fireEvent.click(screen.getByRole("button", { name: /confirm and return/i }));
    expect(confirm).toHaveBeenCalledWith({ entries: [{ label: "alpha" }] }, "");
  });
});

describe("validateDecisionResult parity", () => {
  it("accepts the approval example", () => {
    expect(validateDecisionResult(approval.result_schema, { approved: true, notes: "ship it" })).toEqual({});
  });

  it("accepts the daily standup example", () => {
    expect(
      validateDecisionResult(standup.result_schema, {
        decisions: ["Focus on webhooks"],
        next_actions: ["Write tests"],
      }),
    ).toEqual({});
  });

  it("accepts the decision example", () => {
    expect(
      validateDecisionResult(decision.result_schema, {
        selected_option: "browser",
        constraints: ["no mobile"],
      }),
    ).toEqual({});
  });

  it("surfaces nested object and numeric range errors", () => {
    const nested: JsonSchema = {
      type: "object",
      required: ["limits"],
      properties: {
        limits: {
          type: "object",
          required: ["budget"],
          properties: { budget: { type: "number", minimum: 10, maximum: 20, title: "Budget" } },
        },
      },
    };
    const errors = validateDecisionResult(nested, { limits: { budget: 2 } });
    expect(errors["result.limits.budget"]).toMatch(/at least 10/i);
  });

  it("validates arrays of objects and empty required collections", () => {
    const schemaWithArray: JsonSchema = {
      type: "object",
      required: ["entries"],
      properties: {
        entries: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            required: ["name"],
            properties: { name: { type: "string", minLength: 1 } },
          },
        },
      },
    };
    expect(validateDecisionResult(schemaWithArray, { entries: [] })["result.entries"]).toMatch(/at least 1/i);
    expect(validateDecisionResult(schemaWithArray, { entries: [{ name: "" }] })["result.entries.0.name"]).toMatch(/required|at least 1/i);
  });

  it("allows empty optional values and rejects required empty strings", () => {
    const mixed: JsonSchema = {
      type: "object",
      required: ["title"],
      properties: {
        title: { type: "string", minLength: 1 },
        notes: { type: "string" },
        count: { type: "integer", minimum: 0, maximum: 5 },
      },
    };
    expect(validateDecisionResult(mixed, { title: "ok" })).toEqual({});
    expect(validateDecisionResult(mixed, { title: "", notes: "" })["result.title"]).toMatch(/required|at least/i);
    expect(validateDecisionResult(mixed, { title: "ok", count: 9 })["result.count"]).toMatch(/at most 5/i);
  });

  it("supports oneOf, anyOf, nullable, and additionalProperties", () => {
    expect(
      validateDecisionResult(
        { type: "object", properties: { mode: { oneOf: [{ type: "string", enum: ["a"] }, { type: "integer" }] } } },
        { mode: "a" },
      ),
    ).toEqual({});
    expect(
      Object.keys(
        validateDecisionResult(
          { type: "object", properties: { mode: { oneOf: [{ type: "string", enum: ["a"] }, { type: "integer" }] } } },
          { mode: true },
        ),
      ).length,
    ).toBeGreaterThan(0);
    expect(
      validateDecisionResult(
        { type: "object", properties: { note: { type: ["string", "null"] } } },
        { note: null },
      ),
    ).toEqual({});
    expect(
      validateDecisionResult(
        { type: "object", additionalProperties: false, properties: { ok: { type: "boolean" } } },
        { ok: true, extra: 1 },
      )["result.extra"],
    ).toMatch(/additional/i);
  });
});
