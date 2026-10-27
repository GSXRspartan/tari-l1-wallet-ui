// Encrypts the wallet's backup hex at rest using a PIN-derived key, so the seed never sits in
// plaintext localStorage once a PIN has been set. AES-GCM's auth tag is what lets decryptWithPin
// tell "wrong PIN" apart from any other failure — a wrong key fails the tag check, not just
// producing garbage plaintext.
//
// A PIN has very little entropy, so the key derivation is what stands between a copied
// localStorage and the seed. New blobs use memory-hard Argon2id (`kdf: "argon2id-v1"`), which makes
// every offline guess cost tens of MiB of RAM; blobs written before that carry no `kdf` and are
// PBKDF2-SHA256, still readable and re-encrypted on the next unlock (see `needsRekey`).
import { argon2id } from "hash-wasm";

const LEGACY_PBKDF2_ITERATIONS = 210_000;
const ARGON2 = { parallelism: 1, iterations: 3, memorySize: 64 * 1024, hashLength: 32 } as const; // memorySize in KiB
const SALT_BYTES = 16;
const IV_BYTES = 12;

export interface EncryptedBlob {
  ct: string;
  iv: string;
  salt: string;
  /** Absent on blobs written before Argon2id: PBKDF2-SHA256, 210k iterations. */
  kdf?: "argon2id-v1";
}

export const MIN_PIN_LENGTH = 6;

function toB64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function fromB64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function deriveKey(pin: string, salt: Uint8Array, kdf: EncryptedBlob["kdf"]): Promise<CryptoKey> {
  if (kdf === "argon2id-v1") {
    const raw = await argon2id({ password: pin, salt, ...ARGON2, outputType: "binary" });
    return crypto.subtle.importKey("raw", raw as BufferSource, "AES-GCM", false, ["encrypt", "decrypt"]);
  }
  const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(pin), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: salt as BufferSource, iterations: LEGACY_PBKDF2_ITERATIONS, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function encryptWithPin(plaintext: string, pin: string): Promise<EncryptedBlob> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await deriveKey(pin, salt, "argon2id-v1");
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource }, key, new TextEncoder().encode(plaintext));
  return { ct: toB64(new Uint8Array(ct)), iv: toB64(iv), salt: toB64(salt), kdf: "argon2id-v1" };
}

/** Returns null on a wrong PIN (GCM tag mismatch) rather than throwing. */
export async function decryptWithPin(blob: EncryptedBlob, pin: string): Promise<string | null> {
  try {
    const key = await deriveKey(pin, fromB64(blob.salt), blob.kdf);
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromB64(blob.iv) as BufferSource },
      key,
      fromB64(blob.ct) as BufferSource,
    );
    return new TextDecoder().decode(pt);
  } catch {
    return null;
  }
}

/** True for a blob still on the legacy PBKDF2 key -- re-encrypt it once the PIN is known. */
export function needsRekey(blob: EncryptedBlob): boolean {
  return blob.kdf !== "argon2id-v1";
}
