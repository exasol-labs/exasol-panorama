/**
 * RSAES-PKCS1-v1_5 encryption of the login password.
 *
 * Exasol's WebSocket login encrypts the password with PKCS#1 v1.5 padding.
 * `SubtleCrypto` only implements OAEP, so the (short, public-key-only)
 * operation is done here with BigInt arithmetic. Only the password ever passes
 * through this module, and it never leaves the connection subsystem.
 */

export interface RsaPublicKey {
  readonly modulus: bigint;
  readonly exponent: bigint;
  /** Length of the modulus in bytes; the ciphertext has exactly this length. */
  readonly modulusBytes: number;
}

export class RsaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RsaError';
  }
}

const hexToBigInt = (hex: string): bigint => {
  const cleaned = hex.trim().replace(/^0x/i, '');
  if (cleaned.length === 0 || !/^[0-9a-f]+$/i.test(cleaned)) {
    throw new RsaError(`Invalid hexadecimal value: ${hex}`);
  }
  return BigInt(`0x${cleaned}`);
};

export const publicKeyFromHex = (modulusHex: string, exponentHex: string): RsaPublicKey => {
  const modulus = hexToBigInt(modulusHex);
  const exponent = hexToBigInt(exponentHex);
  if (modulus <= 0n || exponent <= 0n) throw new RsaError('RSA key components must be positive');
  return { modulus, exponent, modulusBytes: Math.ceil(modulus.toString(16).length / 2) };
};

const readDerLength = (bytes: Uint8Array, offset: number): { length: number; next: number } => {
  const first = bytes[offset];
  if (first === undefined) throw new RsaError('Truncated DER length');
  if (first < 0x80) return { length: first, next: offset + 1 };
  const count = first & 0x7f;
  if (count === 0 || count > 4) throw new RsaError('Unsupported DER length encoding');
  let length = 0;
  for (let index = 0; index < count; index += 1) {
    const byte = bytes[offset + 1 + index];
    if (byte === undefined) throw new RsaError('Truncated DER length');
    length = length * 256 + byte;
  }
  return { length, next: offset + 1 + count };
};

const expectTag = (bytes: Uint8Array, offset: number, tag: number): number => {
  if (bytes[offset] !== tag) {
    throw new RsaError(`Expected DER tag 0x${tag.toString(16)} at offset ${offset}`);
  }
  return offset + 1;
};

const bytesToBigInt = (bytes: Uint8Array): bigint => {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
};

const base64ToBytes = (base64: string): Uint8Array => {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
};

export const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

/**
 * Extracts the modulus and exponent from a PEM `SubjectPublicKeyInfo`. Used
 * only when the server omits the hexadecimal key components.
 */
export const publicKeyFromPem = (pem: string): RsaPublicKey => {
  const body = pem
    .replace(/-----BEGIN [A-Z ]+-----/, '')
    .replace(/-----END [A-Z ]+-----/, '')
    .replace(/\s+/g, '');
  if (body.length === 0) throw new RsaError('Empty PEM public key');
  const der = base64ToBytes(body);

  let offset = expectTag(der, 0, 0x30);
  offset = readDerLength(der, offset).next;
  // AlgorithmIdentifier
  offset = expectTag(der, offset, 0x30);
  const algorithm = readDerLength(der, offset);
  offset = algorithm.next + algorithm.length;
  // BIT STRING wrapping the RSAPublicKey
  offset = expectTag(der, offset, 0x03);
  offset = readDerLength(der, offset).next;
  if (der[offset] !== 0x00) throw new RsaError('Unexpected BIT STRING padding');
  offset += 1;

  offset = expectTag(der, offset, 0x30);
  offset = readDerLength(der, offset).next;
  offset = expectTag(der, offset, 0x02);
  const modulusHeader = readDerLength(der, offset);
  const modulusBytes = der.subarray(modulusHeader.next, modulusHeader.next + modulusHeader.length);
  offset = modulusHeader.next + modulusHeader.length;
  offset = expectTag(der, offset, 0x02);
  const exponentHeader = readDerLength(der, offset);
  const exponentBytes = der.subarray(
    exponentHeader.next,
    exponentHeader.next + exponentHeader.length,
  );

  const modulus = bytesToBigInt(modulusBytes);
  // DER integers carry a leading zero byte when the high bit is set.
  const significant = modulusBytes[0] === 0x00 ? modulusBytes.length - 1 : modulusBytes.length;
  return {
    modulus,
    exponent: bytesToBigInt(exponentBytes),
    modulusBytes: significant,
  };
};

const modPow = (base: bigint, exponent: bigint, modulus: bigint): bigint => {
  let result = 1n;
  let factor = base % modulus;
  let remaining = exponent;
  while (remaining > 0n) {
    if ((remaining & 1n) === 1n) result = (result * factor) % modulus;
    factor = (factor * factor) % modulus;
    remaining >>= 1n;
  }
  return result;
};

const defaultRandomBytes = (length: number): Uint8Array =>
  crypto.getRandomValues(new Uint8Array(length));

/** PKCS#1 v1.5 type-2 padding: `0x00 0x02 <non-zero random> 0x00 <message>`. */
export const padPkcs1Type2 = (
  message: Uint8Array,
  modulusBytes: number,
  randomBytes: (length: number) => Uint8Array = defaultRandomBytes,
): Uint8Array => {
  const paddingLength = modulusBytes - message.length - 3;
  if (paddingLength < 8) {
    throw new RsaError('Message is too long for this RSA key');
  }
  const block = new Uint8Array(modulusBytes);
  block[0] = 0x00;
  block[1] = 0x02;
  let written = 0;
  while (written < paddingLength) {
    // Padding bytes must be non-zero; redraw the zeroes rather than biasing them.
    for (const byte of randomBytes(paddingLength - written)) {
      if (byte === 0) continue;
      block[2 + written] = byte;
      written += 1;
    }
  }
  block[2 + paddingLength] = 0x00;
  block.set(message, 3 + paddingLength);
  return block;
};

export const rsaEncryptPkcs1 = (
  key: RsaPublicKey,
  message: Uint8Array,
  randomBytes?: (length: number) => Uint8Array,
): Uint8Array => {
  const block = padPkcs1Type2(message, key.modulusBytes, randomBytes);
  const cipher = modPow(bytesToBigInt(block), key.exponent, key.modulus);
  const hex = cipher.toString(16).padStart(key.modulusBytes * 2, '0');
  const out = new Uint8Array(key.modulusBytes);
  for (let index = 0; index < key.modulusBytes; index += 1) {
    out[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return out;
};

/** Encrypts a password for the Exasol login handshake, base64 encoded. */
export const encryptPassword = (
  key: RsaPublicKey,
  password: string,
  randomBytes?: (length: number) => Uint8Array,
): string => bytesToBase64(rsaEncryptPkcs1(key, new TextEncoder().encode(password), randomBytes));
