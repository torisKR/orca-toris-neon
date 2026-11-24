import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { readBuildIdentity } from '../src/buildid.mjs';
import { releaseFile, fakeCertificate, zip, protoManifest } from './fixtures/release.mjs';
const releaseFileManifest = () => protoManifest({ packageName: 'com.example.water', versionCode: 1 });

async function write(t, name, data) {
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'neon-buildid-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, name);
  await fs.writeFile(file, data);
  return file;
}

test('an AAB is read from the file itself: SHA-256, package, versionCode and the upload certificate digest', async (t) => {
  // Arrange
  const { cert, sha256: certSha } = fakeCertificate();
  const data = releaseFile({ packageName: 'com.example.water', versionCode: 43, cert });
  const file = await write(t, 'app-release.aab', data);
  // Act
  const identity = await readBuildIdentity(file);
  // Assert
  assert.deepEqual(identity, { format: 'aab', sha256: createHash('sha256').update(data).digest('hex'), size: data.length,
    packageName: 'com.example.water', versionCode: '43', signingCertSha256: certSha });
});

test('an AAB whose versionCode is only compiled (no raw string) still reads its versionCode', async (t) => {
  const file = await write(t, 'a.aab', releaseFile({ versionCode: 7, compiledOnly: true }));
  assert.equal((await readBuildIdentity(file)).versionCode, '7');
});

test('an APK binary manifest is read the same way', async (t) => {
  const file = await write(t, 'app-release.apk', releaseFile({ format: 'apk', packageName: 'com.example.fish', versionCode: 120 }));
  const identity = await readBuildIdentity(file);
  assert.equal(identity.format, 'apk');
  assert.equal(identity.packageName, 'com.example.fish');
  assert.equal(identity.versionCode, '120');
});

test('an unsigned build has no certificate digest; a file that is not an Android build is refused', async (t) => {
  // Arrange
  const unsigned = await write(t, 'u.aab', releaseFile({ cert: null }));
  const text = await write(t, 'notes.aab', 'not a zip');
  const empty = await write(t, 'other.aab', zip([{ name: 'readme.txt', data: Buffer.from('x') }]));
  // Act / Assert
  assert.equal((await readBuildIdentity(unsigned)).signingCertSha256, null);
  await assert.rejects(readBuildIdentity(text), /zip/);
  await assert.rejects(readBuildIdentity(empty), /AndroidManifest/);
  const truncated = await write(t, 't.aab', zip([{ name: 'base/manifest/AndroidManifest.xml', data: releaseFileManifest() }, { name: 'META-INF/A.RSA', data: Buffer.from([0x30, 0x84, 0xff]) }]));
  await assert.rejects(readBuildIdentity(truncated), /PKCS#7/, 'a cut certificate header is an error, not the hash of nothing');
});
