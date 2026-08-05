import { describe, expect, it } from "vitest";
import { joinPathFromUrl } from "./settings";

describe("joinPathFromUrl", () => {
  it("keeps the join token in the hash and adds the inbox auto-join flag before it", () => {
    expect(joinPathFromUrl("http://localhost:5173/join/ses_1#token=abc", { autoJoin: true })).toBe(
      "/join/ses_1?autojoin=1#token=abc",
    );
  });

  it("preserves direct join links without auto-joining", () => {
    expect(joinPathFromUrl("http://localhost:5173/join/ses_1?source=inbox#token=abc")).toBe(
      "/join/ses_1?source=inbox#token=abc",
    );
  });
});
