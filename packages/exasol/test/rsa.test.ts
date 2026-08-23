import { beforeAll, describe, expect, it } from 'vitest';
import {
  RsaError,
  bytesToBase64,
  encryptPassword,
  padPkcs1Type2,
  publicKeyFromHex,
  publicKeyFromPem,
  rsaEncryptPkcs1,
} from '@panorama/exasol';

const base64UrlToBigInt = (value: string): bigint => {
  const base64 = value.replaceAll('-', '+').replaceAll('_', '/');
  const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='));
  let result = 0n;
  for (let index = 0; index < binary.length; index += 1) {
    result = (result << 8n) | BigInt(binary.charCodeAt(index));
  }
  return result;
};

const base64ToBytes = (value: string): Uint8Array => {
  const binary = atob(value);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
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

const toPem = (der: ArrayBuffer): string => {
  const base64 = bytesToBase64(new Uint8Array(der));
  const lines = base64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN PUBLIC KEY-----\n${lines.join('\n')}\n-----END PUBLIC KEY-----`;
};

describe('RSA PKCS#1 v1.5', () => {
  let jwk: JsonWebKey;
  let pem: string;

  beforeAll(async () => {
    const pair = await crypto.subtle.generateKey(
      {
        name: 'RSA-OAEP',
        modulusLength: 2048,
        publicExponent: new Uint8Array([0x01, 0x00, 0x01]),
        hash: 'SHA-256',
      },
      true,
      ['encrypt', 'decrypt'],
    );
    jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
    pem = toPem(await crypto.subtle.exportKey('spki', pair.publicKey));
  });

  it('parses the hexadecimal key components the protocol sends', () => {
    const key = publicKeyFromHex('00c3ff', '010001');
    expect(key.exponent).toBe(65_537n);
    expect(key.modulus).toBe(0xc3ffn);
    expect(key.modulusBytes).toBe(2);
  });

  it('counts every byte when the modulus has no leading DER zero', () => {
    // SEQUENCE { SEQUENCE {}, BIT STRING { SEQUENCE { INTEGER 0x7fff, INTEGER 0x03 } } }
    const der = [
      0x30, 0x10, 0x30, 0x00, 0x03, 0x0c, 0x00, 0x30, 0x09, 0x02, 0x02, 0x7f, 0xff, 0x02, 0x03,
      0x00, 0x00, 0x03,
    ];
    const key = publicKeyFromPem(
      `-----BEGIN PUBLIC KEY-----\n${bytesToBase64(Uint8Array.from(der))}\n-----END PUBLIC KEY-----`,
    );
    expect(key.modulus).toBe(0x7fffn);
    expect(key.modulusBytes).toBe(2);
  });

  it('accepts a 0x prefix and rejects malformed hexadecimal', () => {
    expect(publicKeyFromHex('0xff', '0x3').modulus).toBe(255n);
    expect(() => publicKeyFromHex('zz', '010001')).toThrow(RsaError);
    expect(() => publicKeyFromHex('', '010001')).toThrow(RsaError);
    expect(() => publicKeyFromHex('00', '010001')).toThrow(/positive/);
  });

  it('parses a real SPKI PEM public key', () => {
    const fromPem = publicKeyFromPem(pem);
    expect(fromPem.modulus).toBe(base64UrlToBigInt(jwk.n as string));
    expect(fromPem.exponent).toBe(65_537n);
    expect(fromPem.modulusBytes).toBe(256);
  });

  it('rejects malformed PEM input', () => {
    const pemOf = (bytes: readonly number[]): string =>
      `-----BEGIN PUBLIC KEY-----\n${bytesToBase64(Uint8Array.from(bytes))}\n-----END PUBLIC KEY-----`;

    expect(() => publicKeyFromPem('')).toThrow(/Empty PEM/);
    // Wrong outer tag.
    expect(() => publicKeyFromPem(pemOf([0x31, 0x01, 0x00]))).toThrow(/Expected DER tag/);
    // Truncated length byte.
    expect(() => publicKeyFromPem(pemOf([0x30]))).toThrow(/Truncated DER length/);
    // Indefinite and oversized length encodings.
    expect(() => publicKeyFromPem(pemOf([0x30, 0x80, 0x00]))).toThrow(/Unsupported DER length/);
    expect(() => publicKeyFromPem(pemOf([0x30, 0x85, 1, 2, 3, 4, 5]))).toThrow(
      /Unsupported DER length/,
    );
    // Multi-byte length that runs off the end of the buffer.
    expect(() => publicKeyFromPem(pemOf([0x30, 0x82, 0x01]))).toThrow(/Truncated DER length/);
    // Valid header, but the BIT STRING lacks its zero pad byte.
    expect(() =>
      publicKeyFromPem(pemOf([0x30, 0x08, 0x30, 0x02, 0x06, 0x00, 0x03, 0x02, 0x01, 0x00])),
    ).toThrow(/BIT STRING padding/);
  });

  it('keeps the leading DER zero byte out of the modulus length', () => {
    // SEQUENCE { SEQUENCE {}, BIT STRING { SEQUENCE { INTEGER 0x00ff, INTEGER 0x03 } } }
    const der = [
      0x30, 0x11, 0x30, 0x00, 0x03, 0x0d, 0x00, 0x30, 0x0a, 0x02, 0x03, 0x00, 0x00, 0xff, 0x02,
      0x03, 0x00, 0x00, 0x03,
    ];
    const key = publicKeyFromPem(
      `-----BEGIN PUBLIC KEY-----\n${bytesToBase64(Uint8Array.from(der))}\n-----END PUBLIC KEY-----`,
    );
    expect(key.modulus).toBe(255n);
    expect(key.exponent).toBe(3n);
    expect(key.modulusBytes).toBe(2);
  });

  it('counts every byte when the modulus has no leading DER zero', () => {
    // SEQUENCE { SEQUENCE {}, BIT STRING { SEQUENCE { INTEGER 0x7fff, INTEGER 0x03 } } }
    const der = [
      0x30, 0x10, 0x30, 0x00, 0x03, 0x0c, 0x00, 0x30, 0x09, 0x02, 0x02, 0x7f, 0xff, 0x02, 0x03,
      0x00, 0x00, 0x03,
    ];
    const key = publicKeyFromPem(
      `-----BEGIN PUBLIC KEY-----\n${bytesToBase64(Uint8Array.from(der))}\n-----END PUBLIC KEY-----`,
    );
    expect(key.modulus).toBe(0x7fffn);
    expect(key.modulusBytes).toBe(2);
  });

  it('pads to the modulus length with non-zero random bytes', () => {
    const message = new TextEncoder().encode('secret');
    const block = padPkcs1Type2(message, 64, (length) => new Uint8Array(length).fill(7));
    expect(block).toHaveLength(64);
    expect(block[0]).toBe(0x00);
    expect(block[1]).toBe(0x02);
    expect(block[64 - message.length - 1]).toBe(0x00);
    expect(block.slice(2, 64 - message.length - 1).every((byte) => byte === 7)).toBe(true);
    expect([...block.slice(-6)]).toEqual([...message]);
  });

  it('redraws zero padding bytes instead of emitting them', () => {
    let call = 0;
    const block = padPkcs1Type2(new Uint8Array([1]), 32, (length) => {
      call += 1;
      return call === 1 ? new Uint8Array(length) : new Uint8Array(length).fill(9);
    });
    expect(block.slice(2, 30).every((byte) => byte === 9)).toBe(true);
  });

  it('refuses messages that cannot be padded safely', () => {
    expect(() => padPkcs1Type2(new Uint8Array(60), 64)).toThrow(/too long/);
  });

  it('produces ciphertext a real private key decrypts back to the password', () => {
    const key = publicKeyFromPem(pem);
    const password = 'sys-p4ssw0rd!';
    const cipher = base64ToBytes(encryptPassword(key, password));
    expect(cipher).toHaveLength(256);

    let value = 0n;
    for (const byte of cipher) value = (value << 8n) | BigInt(byte);
    const plain = modPow(value, base64UrlToBigInt(jwk.d as string), key.modulus);

    const hex = plain.toString(16).padStart(510, '0');
    const bytes = Uint8Array.from(hex.match(/.{2}/g) ?? [], (pair) => Number.parseInt(pair, 16));
    // Leading 0x00 is dropped by the integer conversion, so the block starts at 0x02.
    expect(bytes[0]).toBe(0x02);
    const separator = bytes.indexOf(0x00, 1);
    expect(separator).toBeGreaterThanOrEqual(9);
    expect(new TextDecoder().decode(bytes.slice(separator + 1))).toBe(password);
  });

  it('uses the platform random source by default', () => {
    const key = publicKeyFromHex('c3'.repeat(64), '010001');
    const first = rsaEncryptPkcs1(key, new TextEncoder().encode('a'));
    const second = rsaEncryptPkcs1(key, new TextEncoder().encode('a'));
    expect(first).toHaveLength(64);
    expect(bytesToBase64(first)).not.toBe(bytesToBase64(second));
  });
});
