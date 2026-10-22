import { DEFAULT_LIMITS, InvalidProjectError, PayloadTooLargeError } from "@latex-api/core";
import { describe, expect, it } from "vitest";
import { extractZip, stripCommonRoot } from "../src/zip";

// Minimal stored (uncompressed) zip writer for tests.
function crc32(buf: Uint8Array): number {
  let c: number;
  const table: number[] = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0 ^ -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]!) & 0xff]!;
  return (crc ^ -1) >>> 0;
}

function makeZip(entries: Array<{ name: string; data: string; symlink?: boolean }>): Uint8Array {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const data = Buffer.from(e.data, "utf8");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(0, 10);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, name, data);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(0x0314, 4); // made by unix
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt32LE(0, 12);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(((e.symlink ? 0o120777 : 0o100644) << 16) >>> 0, 38);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, name);
    offset += local.length + name.length + data.length;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return new Uint8Array(Buffer.concat([...parts, cdBuf, eocd]));
}

describe("extractZip", () => {
  it("extracts files and strips a common root folder", async () => {
    const zip = makeZip([
      { name: "paper/main.tex", data: "\\documentclass{article}" },
      { name: "paper/sections/intro.tex", data: "hi" },
      { name: "__MACOSX/paper/._main.tex", data: "junk" },
    ]);
    const files = await extractZip(zip, DEFAULT_LIMITS);
    expect(files.map((f) => f.path).sort()).toEqual(["main.tex", "sections/intro.tex"]);
    expect(
      new TextDecoder().decode(files.find((f) => f.path === "sections/intro.tex")!.content),
    ).toBe("hi");
  });

  it("rejects traversal, symlinks and oversized archives", async () => {
    await expect(
      extractZip(makeZip([{ name: "../evil.tex", data: "" }]), DEFAULT_LIMITS),
    ).rejects.toThrow(InvalidProjectError);
    await expect(
      extractZip(
        makeZip([{ name: "link.tex", data: "/etc/passwd", symlink: true }]),
        DEFAULT_LIMITS,
      ),
    ).rejects.toThrow(/Symbolic/);
    await expect(
      extractZip(makeZip([{ name: "a.tex", data: "x".repeat(2000) }]), {
        ...DEFAULT_LIMITS,
        maxFileBytes: 1000,
      }),
    ).rejects.toThrow(PayloadTooLargeError);
    await expect(
      extractZip(
        makeZip([
          { name: "a.tex", data: "" },
          { name: "b.tex", data: "" },
        ]),
        { ...DEFAULT_LIMITS, maxFiles: 1 },
      ),
    ).rejects.toThrow(PayloadTooLargeError);
    await expect(extractZip(new Uint8Array([1, 2, 3]), DEFAULT_LIMITS)).rejects.toThrow(
      InvalidProjectError,
    );
  });

  it("does not strip when files are at the root", () => {
    const files = [
      { path: "main.tex", content: new Uint8Array() },
      { path: "a/b.tex", content: new Uint8Array() },
    ];
    expect(stripCommonRoot(files).map((f) => f.path)).toEqual(["main.tex", "a/b.tex"]);
  });
});
