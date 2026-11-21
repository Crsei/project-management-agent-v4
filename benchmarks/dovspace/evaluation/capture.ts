import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { benchmarkConfig } from '../benchmark.config.ts';

const keyIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
/** This descriptor must come from an independently preregistered authority, never the submitted bundle. */
export const CaptureKeySchema = z.object({ keyId: keyIdSchema, publicKeyPem: z.string().min(1).max(16_384), publicKeySha256: sha256Schema }).strict();
export type TrustedCaptureKey = z.infer<typeof CaptureKeySchema>;
export const CaptureKeyOptionsSchema = z.object({
  keyId: keyIdSchema,
  privateKeyPath: z.string().min(1).refine(value => path.isAbsolute(value) && value === path.resolve(value) && !value.includes('\0'), 'Capture key path must be explicit, absolute and canonical'),
  expectedPublicKeySha256: sha256Schema.optional(),
}).strict();
export type CaptureKeyOptions = z.infer<typeof CaptureKeyOptionsSchema>;
declare const captureSignerBrand: unique symbol;
export type CaptureSigner = Readonly<TrustedCaptureKey> & { readonly [captureSignerBrand]: true };
export interface CaptureAttestation {
  schemaVersion: 1;
  algorithm: 'Ed25519';
  keyId: string;
  publicKeySha256: string;
  payloadSha256: string;
  payload: unknown;
  signatureBase64: string;
}
const privateKeys = new WeakMap<CaptureSigner, KeyObject>();
const MAX_KEY_BYTES = 16_384;
const envelopeFields = ['algorithm', 'keyId', 'payload', 'payloadSha256', 'publicKeySha256', 'schemaVersion', 'signatureBase64'];

/** Strict JSON only: no accessors, custom serializers, sparse arrays, omitted values or cyclic aliases. */
function canonicalJson(value: unknown, ancestors = new Set<object>()): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (typeof value !== 'object' || value === null || ancestors.has(value)) throw new Error('Capture values must be finite acyclic JSON');
  const array = Array.isArray(value);
  if (!array && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new Error('Capture values must use plain JSON objects');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(value);
  if (keys.some(key => typeof key !== 'string')) throw new Error('Capture JSON cannot contain symbol keys');
  ancestors.add(value);
  try {
    if (array) {
      if (keys.length !== value.length + 1) throw new Error('Capture JSON arrays must be dense and undecorated');
      const items: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const property = descriptors[String(index)];
        if (!property || !property.enumerable || !Object.hasOwn(property, 'value')) throw new Error('Capture JSON cannot contain accessors or sparse arrays');
        items.push(canonicalJson(property.value, ancestors));
      }
      return `[${items.join(',')}]`;
    }
    return `{${(keys as string[]).sort().map(key => {
      const property = descriptors[key]!;
      if (!property.enumerable || !Object.hasOwn(property, 'value')) throw new Error('Capture JSON cannot contain hidden properties or accessors');
      return `${JSON.stringify(key)}:${canonicalJson(property.value, ancestors)}`;
    }).join(',')}}`;
  } finally { ancestors.delete(value); }
}
export function captureDigest(value: unknown): string { return createHash('sha256').update(canonicalJson(value)).digest('hex'); }
function payloadKind(payload: unknown): string {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !Object.hasOwn(payload, 'kind') || typeof (payload as Record<string, unknown>).kind !== 'string' || !(payload as Record<string, string>).kind) throw new Error('Capture payload requires an explicit nonempty kind');
  return (payload as Record<string, string>).kind!;
}
function signingBytes(envelope: Omit<CaptureAttestation, 'signatureBase64'>): Buffer {
  return Buffer.from(`dovspace.capture.v1\n${JSON.stringify(payloadKind(envelope.payload))}\n${canonicalJson(envelope)}`, 'utf8');
}
function publicDescriptor(keyId: string, key: KeyObject): TrustedCaptureKey {
  if (key.asymmetricKeyType !== 'ed25519' || key.type !== 'public') throw new Error('Capture keys must be Ed25519');
  const publicKeySha256 = createHash('sha256').update(key.export({ format: 'der', type: 'spki' })).digest('hex');
  return { keyId, publicKeyPem: key.export({ format: 'pem', type: 'spki' }).toString(), publicKeySha256 };
}
function trustedPublicKey(input: TrustedCaptureKey): { descriptor: TrustedCaptureKey; key: KeyObject } {
  const descriptor = CaptureKeySchema.parse(input);
  if (!/^-----BEGIN PUBLIC KEY-----\r?\n[A-Za-z0-9+/=\r\n]+-----END PUBLIC KEY-----\s*$/.test(descriptor.publicKeyPem)) throw new Error('Capture trust requires a public SPKI PEM key');
  let key: KeyObject;
  try { key = createPublicKey({ key: descriptor.publicKeyPem, format: 'pem', type: 'spki' }); }
  catch { throw new Error('Invalid trusted capture public key (content withheld)'); }
  if (publicDescriptor(descriptor.keyId, key).publicKeySha256 !== descriptor.publicKeySha256) throw new Error('Trusted capture key fingerprint mismatch');
  return { descriptor, key };
}
function explicitKeyPath(value: string): string {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value !== path.resolve(value) || value.includes('\0')) throw new Error('Capture key path must be explicit, absolute and canonical');
  for (const root of [benchmarkConfig.runtimeRoot, benchmarkConfig.outputsRoot]) {
    const relative = path.relative(root, value);
    if (!relative || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) throw new Error('Private capture keys must stay outside benchmark runtime and output mounts');
  }
  return value;
}
function ownerId(): number {
  if (typeof process.getuid !== 'function') throw new Error('Capture keys require host POSIX private-file ownership checks');
  return process.getuid();
}
function assertPrivateDirectory(info: Stats): void {
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== ownerId() || (info.mode & 0o077) !== 0) throw new Error('Capture key directory must be owned and private (0700)');
}
/** A root-owned sticky parent (for example /tmp) cannot replace another owner's private entry. */
async function checkAncestors(directory: string, privateFinal: boolean): Promise<void> {
  const root = path.parse(directory).root;
  const parts = directory.slice(root.length).split(path.sep).filter(Boolean);
  let current = root;
  for (let index = -1; index < parts.length; index += 1) {
    if (index >= 0) current = path.join(current, parts[index]!);
    const info = await lstat(current);
    if (info.isSymbolicLink() || !info.isDirectory() || await realpath(current) !== current) throw new Error('Capture key path has a symlink or redirected ancestor');
    const stickyRoot = info.uid === 0 && (info.mode & 0o1000) !== 0;
    if (info.uid !== 0 && info.uid !== ownerId() || (info.mode & 0o022) !== 0 && !stickyRoot) throw new Error('Capture key path has an untrusted or shared-writable ancestor');
    if (privateFinal && index === parts.length - 1) assertPrivateDirectory(info);
  }
  if (privateFinal && parts.length === 0) assertPrivateDirectory(await lstat(root));
}
function assertPrivateKeyFile(info: Stats): void {
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.uid !== ownerId() || (info.mode & 0o077) !== 0 || info.size < 1 || info.size > MAX_KEY_BYTES) throw new Error('Capture private key must be a bounded owned private single-link regular file');
}
function sameFile(before: Stats, after: Stats): boolean {
  return before.dev === after.dev && before.ino === after.ino && before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs && before.mode === after.mode && before.uid === after.uid && before.nlink === after.nlink;
}
async function privateKeyBytes(filename: string): Promise<Buffer> {
  await checkAncestors(path.dirname(filename), true);
  const expected = await lstat(filename); assertPrivateKeyFile(expected);
  if (await realpath(filename) !== filename) throw new Error('Capture private key path is redirected');
  const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  const bytes = Buffer.alloc(MAX_KEY_BYTES + 1);
  try {
    const before = await file.stat(); assertPrivateKeyFile(before);
    if (!sameFile(expected, before)) throw new Error('Capture private key changed before reading');
    let count = 0;
    while (count < bytes.length) {
      const result = await file.read(bytes, count, bytes.length - count, count);
      if (result.bytesRead === 0) break;
      count += result.bytesRead;
    }
    const after = await file.stat(); assertPrivateKeyFile(after);
    const current = await lstat(filename); assertPrivateKeyFile(current);
    await checkAncestors(path.dirname(filename), true);
    if (!sameFile(before, after) || !sameFile(before, current) || count !== before.size) throw new Error('Capture private key changed while reading');
    return bytes.subarray(0, count);
  } catch (error) { bytes.fill(0); throw error; }
  finally { await file.close(); }
}

export async function generateCaptureKey(options: { keyId: string; keyDirectory: string }): Promise<TrustedCaptureKey & { privateKeyPath: string }> {
  const keyId = keyIdSchema.parse(options.keyId), keyDirectory = explicitKeyPath(options.keyDirectory);
  await checkAncestors(path.dirname(keyDirectory), false);
  // No recursive creation or adoption of a preexisting directory containing untrusted authority.
  await mkdir(keyDirectory, { mode: 0o700 });
  await checkAncestors(keyDirectory, true);
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const descriptor = publicDescriptor(keyId, publicKey), privateKeyPath = path.join(keyDirectory, 'capture-private-key.pem');
  const bytes = Buffer.from(privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(), 'utf8');
  try {
    const file = await open(privateKeyPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      await file.writeFile(bytes); await file.sync();
      const info = await file.stat(); assertPrivateKeyFile(info);
      if (!sameFile(info, await lstat(privateKeyPath))) throw new Error('Capture private key identity changed during creation');
      await checkAncestors(keyDirectory, true);
    } finally { await file.close(); }
  } finally { bytes.fill(0); }
  return { ...descriptor, privateKeyPath };
}
export async function loadCaptureSigner(options: CaptureKeyOptions): Promise<CaptureSigner> {
  const parsed = CaptureKeyOptionsSchema.parse(options);
  const keyId = parsed.keyId, filename = explicitKeyPath(parsed.privateKeyPath);
  const bytes = await privateKeyBytes(filename);
  let privateKey: KeyObject;
  try {
    try { privateKey = createPrivateKey({ key: bytes, format: 'pem', type: 'pkcs8' }); }
    catch { throw new Error('Invalid capture private key (content withheld)'); }
  } finally { bytes.fill(0); }
  if (privateKey.type !== 'private' || privateKey.asymmetricKeyType !== 'ed25519') throw new Error('Capture private key must be Ed25519');
  const descriptor = publicDescriptor(keyId, createPublicKey(privateKey));
  if (parsed.expectedPublicKeySha256 !== undefined && parsed.expectedPublicKeySha256 !== descriptor.publicKeySha256) throw new Error('Capture private key fingerprint mismatch');
  const signer = Object.freeze(descriptor) as CaptureSigner;
  privateKeys.set(signer, privateKey);
  return signer;
}
export function signCapture(signer: CaptureSigner, payload: unknown): CaptureAttestation {
  const privateKey = privateKeys.get(signer);
  if (!privateKey) throw new Error('Capture signing requires an opaque host-loaded signer');
  const snapshot: unknown = JSON.parse(canonicalJson(payload)); payloadKind(snapshot);
  const envelope: Omit<CaptureAttestation, 'signatureBase64'> = { schemaVersion: 1, algorithm: 'Ed25519', keyId: signer.keyId, publicKeySha256: signer.publicKeySha256, payloadSha256: captureDigest(snapshot), payload: snapshot };
  return { ...envelope, signatureBase64: sign(null, signingBytes(envelope), privateKey).toString('base64') };
}
export function verifyCaptureAttestation(input: unknown, trusted: TrustedCaptureKey, expectedPayload?: unknown): unknown {
  const { descriptor, key } = trustedPublicKey(trusted);
  const snapshot: unknown = JSON.parse(canonicalJson(input));
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot) || Object.keys(snapshot).sort().join('\n') !== envelopeFields.join('\n')) throw new Error('Invalid capture attestation envelope');
  const envelope = snapshot as CaptureAttestation;
  if (envelope.schemaVersion !== 1 || envelope.algorithm !== 'Ed25519' || envelope.keyId !== descriptor.keyId || envelope.publicKeySha256 !== descriptor.publicKeySha256) throw new Error('Capture signature algorithm or trusted key identity mismatch');
  if (typeof envelope.payloadSha256 !== 'string' || !sha256Schema.safeParse(envelope.payloadSha256).success || captureDigest(envelope.payload) !== envelope.payloadSha256) throw new Error('Capture payload digest mismatch');
  payloadKind(envelope.payload);
  if (expectedPayload !== undefined && canonicalJson(expectedPayload) !== canonicalJson(envelope.payload)) throw new Error('Capture payload does not match expected capture');
  if (typeof envelope.signatureBase64 !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(envelope.signatureBase64)) throw new Error('Invalid capture signature encoding');
  const signature = Buffer.from(envelope.signatureBase64, 'base64');
  if (signature.length !== 64 || signature.toString('base64') !== envelope.signatureBase64) throw new Error('Invalid capture signature encoding');
  const { signatureBase64: _signature, ...signed } = envelope;
  if (!verify(null, signingBytes(signed), key, signature)) throw new Error('Capture signature verification failed');
  return envelope.payload;
}
