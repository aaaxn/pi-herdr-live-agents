import { describe, expect, it } from "vitest";
import { sliceUtf8 } from "../src/utf8.js";

describe("sliceUtf8", () => {
  it("never cuts a multi-byte character and returns a reusable next offset", () => {
    const value = `abc${"🙂".repeat(4)}xyz`;
    let offset = 0;
    let rebuilt = "";
    do {
      const page = sliceUtf8(value, offset, 8);
      rebuilt += page.text;
      expect(page.text).not.toContain("�");
      if (page.nextOffset === undefined) break;
      offset = page.nextOffset;
    } while (true);

    expect(rebuilt).toBe(value);
  });

  it("rejects arbitrary offsets in the middle of a character", () => {
    expect(() => sliceUtf8("🙂", 1, 10)).toThrow("not a UTF-8 character boundary");
  });
});
