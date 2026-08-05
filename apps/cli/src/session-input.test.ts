import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readSessionCreateInput } from "./session-input.js";

describe("readSessionCreateInput", () => {
  it("reads a session object directly from stdin", () => {
    const payload = readSessionCreateInput(
      { stdin: true },
      (source) => {
        assert.equal(source, 0);
        return '{"objective":"Choose lunch"}';
      },
    );
    assert.deepEqual(payload, { objective: "Choose lunch" });
  });

  it("requires exactly one input source", () => {
    assert.throws(() => readSessionCreateInput({}), /exactly one/);
    assert.throws(
      () => readSessionCreateInput({ file: "session.json", stdin: true }),
      /exactly one/,
    );
  });

  it("rejects invalid and non-object JSON", () => {
    assert.throws(() => readSessionCreateInput({ stdin: true }, () => "{"), /valid JSON/);
    assert.throws(() => readSessionCreateInput({ stdin: true }, () => "[]"), /JSON object/);
  });
});
