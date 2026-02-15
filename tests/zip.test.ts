import { describe, it, expect } from "vitest";
import { buildZipBuffer } from "../src/zip.js";

describe("buildZipBuffer", () => {
  it("produces a valid ZIP for an empty map", () => {
    const buf = buildZipBuffer(new Map());
    expect(buf.readUInt32LE(buf.length - 22)).toBe(0x06054b50);
    expect(buf.readUInt16LE(buf.length - 22 + 8)).toBe(0);
  });

  it("produces a ZIP with correct entry count for one file", () => {
    const files = new Map<string, Buffer>();
    files.set("hello.txt", Buffer.from("Hello, world!"));
    const buf = buildZipBuffer(files);

    expect(buf.readUInt32LE(0)).toBe(0x04034b50);
    expect(buf.readUInt16LE(buf.length - 22 + 8)).toBe(1);
  });

  it("produces a ZIP with correct entry count for multiple files", () => {
    const files = new Map<string, Buffer>();
    files.set("a.txt", Buffer.from("aaa"));
    files.set("b.txt", Buffer.from("bbb"));
    files.set("c.txt", Buffer.from("ccc"));
    const buf = buildZipBuffer(files);

    expect(buf.readUInt16LE(buf.length - 22 + 8)).toBe(3);
  });

  it("stores file data uncompressed (STORE)", () => {
    const content = "test content";
    const files = new Map<string, Buffer>();
    files.set("test.txt", Buffer.from(content));
    const buf = buildZipBuffer(files);

    expect(buf.includes(Buffer.from(content))).toBe(true);
  });
});
