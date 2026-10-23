const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function toBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64");
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function encodeText(text: string): Uint8Array {
  return textEncoder.encode(text);
}

export function decodeText(bytes: Uint8Array): string {
  return textDecoder.decode(bytes);
}

export function isBrowser(): boolean {
  return typeof window !== "undefined" && typeof document !== "undefined";
}

export function envVar(name: string): string | undefined {
  try {
    const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
      ?.env;
    return env?.[name];
  } catch {
    return undefined;
  }
}
