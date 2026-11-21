import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { benchmarkConfig } from '../benchmark.config.ts';
import { prepareReportDirectory } from '../reports/files.ts';
import { CaptureKeyOptionsSchema, CaptureKeySchema, captureDigest, generateCaptureKey, loadCaptureSigner, signCapture, verifyCaptureAttestation, type CaptureKeyOptions, type CaptureSigner, type TrustedCaptureKey } from './capture.ts';
import { CAPTURE_COMMAND_FLAGS, runCaptureCommand } from './commands-capture.ts';

// Public RFC 8032 test seeds; they are never operator signing authority.
const seeds = ['9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60', '4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb'];
const firstPublic = 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a';
async function fixture(t: TestContext) {
  const root = await mkdtemp('/tmp/dovspace-capture-test-');
  const outputs: string[] = [];
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    for (const output of outputs) await rm(output, { recursive: true, force: true });
  });
  const seeded = async (name = 'keys', seed = seeds[0]!) => {
    const directory = path.join(root, name); await mkdir(directory, { mode: 0o700 });
    const key = createPrivateKey({ key: Buffer.from(`302e020100300506032b657004220420${seed}`, 'hex'), format: 'der', type: 'pkcs8' });
    const filename = path.join(directory, 'capture-private-key.pem');
    await writeFile(filename, key.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600, flag: 'wx' });
    const signer = await loadCaptureSigner({ keyId: 'capture-test', privateKeyPath: filename });
    return { directory, filename, key, signer, trusted: CaptureKeySchema.parse(signer) };
  };
  const output = (name: string) => {
    const directory = path.join(benchmarkConfig.outputsRoot, `${path.basename(root)}-${name}`); outputs.push(directory); return directory;
  };
  return { root, seeded, output };
}

test('fixed Ed25519 key signs deterministic canonical JSON with an explicit kind domain', async t => {
  const value = await fixture(t), keys = await value.seeded();
  const payload = { kind: 'runner-admission', runId: 'run-1', nested: { z: 2, a: 1 } };
  const first = signCapture(keys.signer, payload);
  const second = signCapture(keys.signer, { nested: { a: 1, z: 2 }, runId: 'run-1', kind: 'runner-admission' });
  assert.equal(first.signatureBase64, second.signatureBase64);
  const canonical = '{"kind":"runner-admission","nested":{"a":1,"z":2},"runId":"run-1"}';
  assert.equal(first.payloadSha256, createHash('sha256').update(canonical).digest('hex'));
  const publicDer = Buffer.from(`302a300506032b6570032100${firstPublic}`, 'hex');
  assert.equal(keys.signer.publicKeySha256, createHash('sha256').update(publicDer).digest('hex'));
  assert.deepEqual(createPublicKey(keys.key).export({ format: 'der', type: 'spki' }), publicDer);
  const signedJson = `{"algorithm":"Ed25519","keyId":"capture-test","payload":${canonical},"payloadSha256":"${first.payloadSha256}","publicKeySha256":"${first.publicKeySha256}","schemaVersion":1}`;
  const signedBytes = Buffer.from(`dovspace.capture.v1\n"runner-admission"\n${signedJson}`);
  assert.equal(first.signatureBase64, sign(null, signedBytes, keys.key).toString('base64'));
  assert.equal(verify(null, signedBytes, createPublicKey(keys.key), Buffer.from(first.signatureBase64, 'base64')), true);
  assert.deepEqual(verifyCaptureAttestation(first, keys.trusted, payload), payload);
  payload.nested.a = 9;
  assert.deepEqual(verifyCaptureAttestation(first, keys.trusted), { kind: 'runner-admission', runId: 'run-1', nested: { a: 1, z: 2 } });
  assert.throws(() => verifyCaptureAttestation(first, keys.trusted, payload), /expected capture/);
});

test('envelope, payload, recomputed hash and cross-kind signature tampering are denied', async t => {
  const value = await fixture(t), keys = await value.seeded();
  const valid = signCapture(keys.signer, { kind: 'runner-admission', runId: 'run-1' });
  const variants: unknown[] = [
    { ...valid, algorithm: 'HMAC-SHA256' }, { ...valid, schemaVersion: 2 }, { ...valid, keyId: 'other-id' },
    { ...valid, publicKeySha256: '0'.repeat(64) }, { ...valid, payloadSha256: '0'.repeat(64) },
    { ...valid, signatureBase64: Buffer.alloc(64).toString('base64') }, { ...valid, signatureBase64: valid.signatureBase64.slice(0, -2) },
    { ...valid, signatureBase64: `${valid.signatureBase64}\n` }, { ...valid, publicKeyPem: keys.trusted.publicKeyPem },
    { ...valid, payload: { kind: 'runner-admission', runId: 'changed' } },
  ];
  for (const payload of [{ kind: 'runner-admission', runId: 'changed' }, { kind: 'runner-seal', runId: 'run-1' }]) variants.push({ ...valid, payload, payloadSha256: captureDigest(payload) });
  for (const invalid of variants) assert.throws(() => verifyCaptureAttestation(invalid, keys.trusted));
  assert.throws(() => verifyCaptureAttestation({ ...valid, payload: null, payloadSha256: captureDigest(null) }, keys.trusted), /kind/);
});

test('only the external registered key can establish trust, including fingerprint and key ID', async t => {
  const value = await fixture(t), keys = await value.seeded(), other = await value.seeded('other', seeds[1]!);
  const valid = signCapture(keys.signer, { kind: 'runner-seal', manifestSha256: 'a'.repeat(64) });
  assert.throws(() => verifyCaptureAttestation(valid, other.trusted), /key identity/);
  assert.throws(() => verifyCaptureAttestation({ ...valid, publicKeySha256: other.trusted.publicKeySha256 }, other.trusted), /signature verification/);
  assert.throws(() => verifyCaptureAttestation(valid, { ...keys.trusted, keyId: 'different-registration' }), /key identity/);
  assert.throws(() => verifyCaptureAttestation(valid, { ...keys.trusted, publicKeySha256: '0'.repeat(64) }), /fingerprint/);
  assert.throws(() => verifyCaptureAttestation(valid, { ...keys.trusted, publicKeyPem: other.trusted.publicKeyPem }), /fingerprint/);
  assert.throws(() => verifyCaptureAttestation(valid, { ...keys.trusted, publicKeyPem: keys.key.export({ format: 'pem', type: 'pkcs8' }).toString() }), /public SPKI/);
  assert.throws(() => verifyCaptureAttestation(valid, undefined as unknown as TrustedCaptureKey));
  const nonEd25519 = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const nonEdTrust = { keyId: 'capture-test', publicKeyPem: nonEd25519.publicKey.export({ format: 'pem', type: 'spki' }).toString(), publicKeySha256: createHash('sha256').update(nonEd25519.publicKey.export({ format: 'der', type: 'spki' })).digest('hex') };
  assert.throws(() => verifyCaptureAttestation(valid, nonEdTrust), /Ed25519/);
});

test('signers are opaque capabilities and JSON exports never contain private authority', async t => {
  const value = await fixture(t), keys = await value.seeded();
  const payload = { kind: 'runner-admission' };
  const fakes = [{ ...keys.signer }, Object.create(keys.signer) as unknown, JSON.parse(JSON.stringify(keys.signer)) as unknown, { ...keys.signer, privateKey: keys.key }];
  for (const fake of fakes) assert.throws(() => signCapture(fake as CaptureSigner, payload), /opaque host-loaded/);
  assert.equal(Object.isFrozen(keys.signer), true);
  assert.deepEqual(Object.keys(keys.signer).sort(), ['keyId', 'publicKeyPem', 'publicKeySha256']);
  assert.doesNotMatch(JSON.stringify(keys.signer), /PRIVATE KEY|privateKeyPath|capture-private-key/);
  const serializedPrivate = (await readFile(keys.filename, 'utf8')).split('\n')[1]!;
  assert.equal(JSON.stringify(signCapture(keys.signer, payload)).includes(serializedPrivate), false);
  assert.throws(() => signCapture(keys.signer, {}), /kind/);
  assert.throws(() => signCapture(keys.signer, { kind: '' }), /kind/);
  await assert.rejects(() => loadCaptureSigner({ keyId: 'capture-test', privateKeyPath: keys.filename, expectedPublicKeySha256: '0'.repeat(64) }), /fingerprint/);
  assert.equal((await loadCaptureSigner({ keyId: 'capture-test', privateKeyPath: keys.filename, expectedPublicKeySha256: keys.trusted.publicKeySha256 })).publicKeySha256, keys.trusted.publicKeySha256);
});

test('capture canonicalization rejects non-JSON ambiguity without invoking supplied accessors', async t => {
  const value = await fixture(t), keys = await value.seeded();
  assert.equal(captureDigest({ a: 1, Z: 2 }), createHash('sha256').update('{"Z":2,"a":1}').digest('hex'));
  const circular: Record<string, unknown> = {}; circular.self = circular;
  const sparse: unknown[] = []; sparse.length = 1;
  const decorated = Object.assign([1], { extra: 2 });
  const hidden = Object.defineProperty({}, 'private', { value: 1 });
  let getterCalls = 0;
  const getter = Object.defineProperty({}, 'kind', { enumerable: true, get() { getterCalls += 1; return 'runner-admission'; } });
  for (const invalid of [undefined, NaN, Infinity, 1n, { value: undefined }, circular, sparse, decorated, hidden, getter, new Date(0), { [Symbol('not-json')]: 1 }]) assert.throws(() => captureDigest(invalid));
  assert.throws(() => signCapture(keys.signer, getter)); assert.equal(getterCalls, 0);
  const shared = { a: 1 }; assert.equal(captureDigest([shared, shared]), captureDigest([{ a: 1 }, { a: 1 }]));
});

test('keygen creates fresh private directories and real usable Ed25519 keys without returning bytes', async t => {
  const value = await fixture(t), directory = path.join(value.root, 'generated');
  const generated = await generateCaptureKey({ keyId: 'fresh-capture', keyDirectory: directory });
  const { privateKeyPath, ...trusted } = generated;
  assert.equal((await lstat(directory)).mode & 0o777, 0o700);
  assert.equal((await lstat(privateKeyPath)).mode & 0o777, 0o600);
  assert.equal((await lstat(privateKeyPath)).nlink, 1);
  assert.deepEqual(await readdir(directory), ['capture-private-key.pem']);
  const signer = await loadCaptureSigner({ keyId: trusted.keyId, privateKeyPath, expectedPublicKeySha256: trusted.publicKeySha256 });
  const payload = { kind: 'runner-admission', attemptId: 'generated-attempt' };
  assert.deepEqual(verifyCaptureAttestation(signCapture(signer, payload), trusted), payload);
  assert.doesNotMatch(JSON.stringify(generated), /PRIVATE KEY/);
  const before = await readFile(privateKeyPath);
  await assert.rejects(() => generateCaptureKey({ keyId: 'new-id', keyDirectory: directory }), /EEXIST/);
  assert.deepEqual(await readFile(privateKeyPath), before);
  await chmod(privateKeyPath, 0o400);
  assert.equal((await loadCaptureSigner({ keyId: trusted.keyId, privateKeyPath })).publicKeySha256, trusted.publicKeySha256);
});

test('private file and directory symlinks and key hardlinks cannot load or redirect keygen', async t => {
  const value = await fixture(t), keys = await value.seeded();
  const fileLink = path.join(keys.directory, 'linked-key.pem'); await symlink(keys.filename, fileLink);
  await assert.rejects(() => loadCaptureSigner({ keyId: 'capture-test', privateKeyPath: fileLink }), /single-link regular file/);
  const directoryLink = path.join(value.root, 'linked-directory'); await symlink(keys.directory, directoryLink);
  await assert.rejects(() => loadCaptureSigner({ keyId: 'capture-test', privateKeyPath: path.join(directoryLink, 'capture-private-key.pem') }), /symlink|redirected/);
  await assert.rejects(() => generateCaptureKey({ keyId: 'capture-test', keyDirectory: path.join(directoryLink, 'new-keys') }), /symlink|redirected/);
  await assert.rejects(() => generateCaptureKey({ keyId: 'capture-test', keyDirectory: directoryLink }), /EEXIST/);
  await assert.rejects(() => lstat(path.join(keys.directory, 'new-keys')), { code: 'ENOENT' });
  const hardlink = path.join(keys.directory, 'hardlink.pem'); await link(keys.filename, hardlink);
  for (const filename of [keys.filename, hardlink]) await assert.rejects(() => loadCaptureSigner({ keyId: 'capture-test', privateKeyPath: filename }), /single-link/);
  await rm(hardlink);
  assert.equal((await loadCaptureSigner({ keyId: 'capture-test', privateKeyPath: keys.filename })).publicKeySha256, keys.trusted.publicKeySha256);
});

test('shared permissions, oversized keys and malformed or non-Ed25519 private keys fail closed', async t => {
  const value = await fixture(t), keys = await value.seeded();
  await chmod(keys.filename, 0o644);
  await assert.rejects(() => loadCaptureSigner({ keyId: 'capture-test', privateKeyPath: keys.filename }), /private single-link/);
  await chmod(keys.filename, 0o600); await chmod(keys.directory, 0o755);
  await assert.rejects(() => loadCaptureSigner({ keyId: 'capture-test', privateKeyPath: keys.filename }), /private \(0700\)/);
  await chmod(keys.directory, 0o700);
  const shared = path.join(value.root, 'shared'); await mkdir(shared, { mode: 0o700 }); await chmod(shared, 0o777);
  await assert.rejects(() => generateCaptureKey({ keyId: 'capture-test', keyDirectory: path.join(shared, 'keys') }), /shared-writable/);
  await chmod(shared, 0o700);
  await writeFile(keys.filename, Buffer.alloc(16_385, 65));
  await assert.rejects(() => loadCaptureSigner({ keyId: 'capture-test', privateKeyPath: keys.filename }), /bounded/);
  await writeFile(keys.filename, 'SECRET_MALFORMED_PRIVATE_KEY');
  await assert.rejects(() => loadCaptureSigner({ keyId: 'capture-test', privateKeyPath: keys.filename }), error => error instanceof Error && error.message.includes('content withheld') && !error.message.includes('SECRET_MALFORMED'));
  await writeFile(keys.filename, generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ format: 'pem', type: 'pkcs8' }));
  await assert.rejects(() => loadCaptureSigner({ keyId: 'capture-test', privateKeyPath: keys.filename }), /Ed25519/);
});

test('key locations are explicit canonical host paths, never runtime or output mounts', async t => {
  const value = await fixture(t), keys = await value.seeded();
  await assert.rejects(() => loadCaptureSigner({ keyId: 'capture-test' } as CaptureKeyOptions));
  assert.equal(CaptureKeyOptionsSchema.safeParse({ keyId: 'capture-test', privateKeyPath: keys.filename }).success, true);
  assert.equal(CaptureKeyOptionsSchema.safeParse({ keyId: 'capture-test', privateKeyPath: keys.filename, publicKeyPem: keys.trusted.publicKeyPem }).success, false);
  assert.equal(CaptureKeyOptionsSchema.safeParse({ keyId: 'capture-test', privateKeyPath: keys.filename, expectedPublicKeySha256: 'not-a-sha256' }).success, false);
  await assert.rejects(() => loadCaptureSigner({ keyId: 'capture-test', privateKeyPath: 'capture-private-key.pem' }), /absolute/);
  const aliased = `${keys.directory}/../${path.basename(keys.directory)}/capture-private-key.pem`;
  await assert.rejects(() => loadCaptureSigner({ keyId: 'capture-test', privateKeyPath: aliased }), /canonical/);
  for (const root of [benchmarkConfig.outputsRoot, benchmarkConfig.runtimeRoot]) {
    const directory = path.join(root, `${path.basename(value.root)}-forbidden`);
    await assert.rejects(() => generateCaptureKey({ keyId: 'capture-test', keyDirectory: directory }), /outside benchmark runtime and output mounts/);
    await assert.rejects(() => loadCaptureSigner({ keyId: 'capture-test', privateKeyPath: path.join(directory, 'capture-private-key.pem') }), /outside benchmark runtime and output mounts/);
    await assert.rejects(() => lstat(directory), { code: 'ENOENT' });
  }
});

test('capture-keygen command exports only a public descriptor and private path, with exact flags', async t => {
  const value = await fixture(t), input = path.join(value.root, 'keygen-input.json'), output = value.output('keygen');
  const keyDirectory = path.join(value.root, 'command-private-key');
  await writeFile(input, JSON.stringify({ keyId: 'command-key', keyDirectory }), { mode: 0o600 });
  const command = await runCaptureCommand('capture-keygen', { input, 'output-root': output });
  assert.equal(command?.exitCode, 0);
  const serialized = await readFile(path.join(output, 'capture-key.json'), 'utf8');
  const result = JSON.parse(serialized) as TrustedCaptureKey & { privateKeyPath: string; operation: string; inferencePerformed: boolean };
  assert.deepEqual(command?.result, result);
  assert.equal(result.operation, 'capture-keygen'); assert.equal(result.inferencePerformed, false);
  assert.equal(result.privateKeyPath, path.join(keyDirectory, 'capture-private-key.pem'));
  assert.match(result.publicKeyPem, /BEGIN PUBLIC KEY/); assert.doesNotMatch(serialized, /PRIVATE KEY/);
  assert.deepEqual((await readdir(output)).sort(), ['capture-key-options.json', 'capture-key.json', 'capture-public-key.json']);
  const options = CaptureKeyOptionsSchema.parse(JSON.parse(await readFile(path.join(output, 'capture-key-options.json'), 'utf8')));
  const exportedPublic = CaptureKeySchema.parse(JSON.parse(await readFile(path.join(output, 'capture-public-key.json'), 'utf8')));
  assert.equal(options.expectedPublicKeySha256, exportedPublic.publicKeySha256);
  assert.equal(options.privateKeyPath, result.privateKeyPath);
  assert.equal(exportedPublic.publicKeyPem, result.publicKeyPem);
  const privateBytes = await readFile(result.privateKeyPath, 'utf8'); assert.equal(serialized.includes(privateBytes.split('\n')[1]!), false);
  const signer = await loadCaptureSigner({ keyId: result.keyId, privateKeyPath: result.privateKeyPath });
  const trusted = { keyId: result.keyId, publicKeyPem: result.publicKeyPem, publicKeySha256: result.publicKeySha256 };
  const payload = { kind: 'runner-admission', attemptId: 'command-attempt' };
  assert.deepEqual(verifyCaptureAttestation(signCapture(signer, payload), trusted), payload);
  await assert.rejects(() => runCaptureCommand('capture-keygen', { input, 'output-root': output }), /already exists/);
  await assert.rejects(() => runCaptureCommand('capture-keygen', { input, 'output-root': value.output('bad-flag'), payload: 'arbitrary-signing-request' }), /Unsupported/);
  await assert.rejects(() => runCaptureCommand('capture-keygen', { input }), /Missing --output-root/);
  await assert.rejects(() => runCaptureCommand('capture-keygen', { 'output-root': value.output('missing-input') }), /Missing --input/);
  await assert.rejects(() => runCaptureCommand('capture-keygen', { input, 'output-root': path.join(value.root, 'not-reserved') }), /reserved benchmark outputs/);
  assert.deepEqual(Object.keys(CAPTURE_COMMAND_FLAGS), ['capture-keygen']);
  assert.equal(await runCaptureCommand('capture-sign', { input }), undefined);
  await writeFile(input, JSON.stringify({ keyId: 'bad-request', keyDirectory: path.join(value.root, 'must-not-create'), payload: { kind: 'runner-seal' } }));
  await assert.rejects(() => runCaptureCommand('capture-keygen', { input, 'output-root': value.output('arbitrary-payload') }));
  await assert.rejects(() => lstat(path.join(value.root, 'must-not-create')), { code: 'ENOENT' });
});

test('capture-keygen refuses redirected outputs before creating private key material', async t => {
  const value = await fixture(t), input = path.join(value.root, 'input.json'), keyDirectory = path.join(value.root, 'not-created');
  await writeFile(input, JSON.stringify({ keyId: 'redirect-test', keyDirectory }), { mode: 0o600 });
  const parent = value.output('link-parent'); await prepareReportDirectory(parent, true);
  await symlink(value.root, path.join(parent, 'redirect'));
  await assert.rejects(() => runCaptureCommand('capture-keygen', { input, 'output-root': path.join(parent, 'redirect', 'output') }), /symlink|redirected/);
  await assert.rejects(() => lstat(keyDirectory), { code: 'ENOENT' });
});
