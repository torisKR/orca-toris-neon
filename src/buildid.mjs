/**
 * The build identity of an Android release file, read from the file itself (roadmap item 2): its
 * SHA-256, package, versionCode and the SHA-256 of its v1 (JAR) signing certificate, the same value
 * `keytool -printcert -jarfile` prints. An AAB keeps its manifest as aapt2 protobuf, an APK as binary
 * XML. Only the zip directory and three small entries are read; nothing is run.
 * ponytail: no zip64, no indefinite-length BER, and v2/v3-only APK signatures read as no certificate.
 */
import { createHash } from 'node:crypto';
import { promises as fs, constants as FS } from 'node:fs';
import { inflateRawSync } from 'node:zlib';

const MAX_ENTRY = 8 * 1024 * 1024;
const TAIL = 65_557; // end of central directory (22) + the longest comment
const AAB_MANIFEST = 'base/manifest/AndroidManifest.xml';
const APK_MANIFEST = 'AndroidManifest.xml';
const SIGNATURE = /^META-INF\/[^/]+\.(RSA|DSA|EC)$/i;
const VERSION_CODE_ID = 0x0101021b;
const refuse = (message) => Object.assign(new Error(message), { code: 'invalid_release_file' });

const CHUNK = 1024 * 1024;
/** SHA-256 of the same open file the manifest was read from, so a file swapped in between cannot mix two builds. */
async function digest(handle, size) {
  const hash = createHash('sha256'), buffer = Buffer.alloc(CHUNK);
  for (let at = 0; at < size;) {
    const { bytesRead } = await handle.read(buffer, 0, Math.min(CHUNK, size - at), at);
    if (!bytesRead) throw refuse('파일을 끝까지 읽지 못했습니다.');
    hash.update(buffer.subarray(0, bytesRead));
    at += bytesRead;
  }
  return hash.digest('hex');
}

/** name → { method, compressed, size, local } from the central directory. */
async function zipEntries(handle, size) {
  const tail = Buffer.alloc(Math.min(size, TAIL));
  await handle.read(tail, 0, tail.length, size - tail.length);
  const end = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0 || end + 22 > tail.length) throw refuse('zip 형식(AAB/APK)이 아닙니다.');
  const count = tail.readUInt16LE(end + 10), length = tail.readUInt32LE(end + 12), offset = tail.readUInt32LE(end + 16);
  if (offset + length > size) throw refuse('zip 목록이 파일 밖을 가리킵니다.');
  const dir = Buffer.alloc(length);
  await handle.read(dir, 0, length, offset);
  const entries = new Map();
  for (let at = 0, n = 0; n < count && at + 46 <= dir.length; n++) {
    if (dir.readUInt32LE(at) !== 0x02014b50) throw refuse('zip 목록이 손상됐습니다.');
    const nameLength = dir.readUInt16LE(at + 28), name = dir.toString('utf8', at + 46, at + 46 + nameLength);
    entries.set(name, { method: dir.readUInt16LE(at + 10), compressed: dir.readUInt32LE(at + 20), size: dir.readUInt32LE(at + 24), local: dir.readUInt32LE(at + 42) });
    at += 46 + nameLength + dir.readUInt16LE(at + 30) + dir.readUInt16LE(at + 32);
  }
  return entries;
}

async function entryData(handle, entry) {
  if (entry.size > MAX_ENTRY || entry.compressed > MAX_ENTRY) throw refuse('zip 항목이 너무 큽니다.');
  const header = Buffer.alloc(30);
  await handle.read(header, 0, 30, entry.local);
  if (header.readUInt32LE(0) !== 0x04034b50) throw refuse('zip 항목 머리가 손상됐습니다.');
  const data = Buffer.alloc(entry.compressed);
  await handle.read(data, 0, data.length, entry.local + 30 + header.readUInt16LE(26) + header.readUInt16LE(28));
  if (entry.method === 0) return data;
  if (entry.method === 8) return inflateRawSync(data, { maxOutputLength: MAX_ENTRY });
  throw refuse('지원하지 않는 zip 압축 방식입니다: ' + entry.method);
}

// Protobuf: (field number, value) pairs; length-delimited values are Buffers.
function varint(buf, at) {
  let value = 0, scale = 1;
  for (;;) {
    if (at >= buf.length) throw refuse('manifest protobuf가 손상됐습니다.');
    const byte = buf[at++];
    value += (byte & 0x7f) * scale;
    if (!(byte & 0x80)) return [value, at];
    scale *= 128;
  }
}
function fields(buf) {
  const out = [];
  for (let at = 0; at < buf.length;) {
    const [key, next] = varint(buf, at);
    at = next;
    const type = key % 8, no = Math.floor(key / 8);
    if (type === 0) { const [value, after] = varint(buf, at); out.push([no, value]); at = after; }
    else if (type === 2) { const [length, after] = varint(buf, at); out.push([no, buf.subarray(after, after + length)]); at = after + length; }
    else if (type === 5) at += 4;
    else if (type === 1) at += 8;
    else throw refuse('manifest protobuf가 손상됐습니다.');
  }
  return out;
}
const first = (list, no) => list.find(([number]) => number === no)?.[1];
const text = (value) => Buffer.isBuffer(value) ? value.toString('utf8') : '';
const EMPTY = Buffer.alloc(0);

/** aapt2 XmlNode → XmlElement(name 3, attribute 4 → name 2, value 3, compiled_item 6 → prim 7 → int 6 / hex 7). */
function protoManifest(buf) {
  const element = fields(first(fields(buf), 1) ?? EMPTY);
  if (text(first(element, 3)) !== 'manifest') throw refuse('AndroidManifest의 최상위 요소가 manifest가 아닙니다.');
  const attributes = element.filter(([no]) => no === 4).map(([, value]) => fields(value));
  const value = (name) => {
    const attribute = attributes.find((item) => text(first(item, 2)) === name);
    if (!attribute) return null;
    const raw = text(first(attribute, 3));
    if (raw) return raw;
    const prim = fields(first(fields(first(attribute, 6) ?? EMPTY), 7) ?? EMPTY);
    const number = first(prim, 6) ?? first(prim, 7);
    return number === undefined ? null : String(number);
  };
  return { packageName: value('package'), versionCode: value('versionCode') };
}

function stringPool(buf, at) {
  const count = buf.readUInt32LE(at + 8), utf8 = Boolean(buf.readUInt32LE(at + 16) & 0x100), start = at + buf.readUInt32LE(at + 20);
  const length8 = (p) => buf[p] & 0x80 ? [((buf[p] & 0x7f) << 8) | buf[p + 1], p + 2] : [buf[p], p + 1];
  return Array.from({ length: count }, (_, index) => {
    let p = start + buf.readUInt32LE(at + buf.readUInt16LE(at + 2) + index * 4);
    if (utf8) { p = length8(p)[1]; const [bytes, from] = length8(p); return buf.toString('utf8', from, from + bytes); }
    let length = buf.readUInt16LE(p);
    if (length & 0x8000) { length = ((length & 0x7fff) << 16) | buf.readUInt16LE(p + 2); p += 2; }
    return buf.toString('utf16le', p + 2, p + 2 + length * 2);
  });
}

/** Android binary XML: string pool, resource ids, then the <manifest> start element's attributes. */
function binaryManifest(buf) {
  if (buf.length < 8 || buf.readUInt16LE(0) !== 0x0003) throw refuse('AndroidManifest가 바이너리 XML이 아닙니다.');
  let strings = [], ids = [];
  for (let at = buf.readUInt16LE(2); at + 8 <= buf.length;) {
    const type = buf.readUInt16LE(at), size = buf.readUInt32LE(at + 4);
    if (size < 8) break;
    if (type === 0x0001) strings = stringPool(buf, at);
    else if (type === 0x0180) ids = Array.from({ length: (size - 8) / 4 }, (_, index) => buf.readUInt32LE(at + 8 + index * 4));
    else if (type === 0x0102) {
      const ext = at + buf.readUInt16LE(at + 2);
      if (strings[buf.readUInt32LE(ext + 4)] !== 'manifest') { at += size; continue; }
      const result = { packageName: null, versionCode: null };
      const start = buf.readUInt16LE(ext + 8), stride = buf.readUInt16LE(ext + 10);
      for (let index = 0; index < buf.readUInt16LE(ext + 12); index++) {
        const a = ext + start + index * stride, name = buf.readUInt32LE(a + 4), raw = buf.readUInt32LE(a + 8), kind = buf[a + 15], data = buf.readUInt32LE(a + 16);
        const value = raw !== 0xffffffff ? strings[raw] : kind === 0x03 ? strings[data] : kind === 0x10 || kind === 0x11 ? String(data) : null;
        if (strings[name] === 'package') result.packageName = value;
        if (strings[name] === 'versionCode' || ids[name] === VERSION_CODE_ID) result.versionCode = value;
      }
      return result;
    }
    at += size;
  }
  throw refuse('AndroidManifest에서 manifest 요소를 찾지 못했습니다.');
}

// DER: { tag, start, body, end } of the element at `at`.
function tlv(buf, at) {
  if (at + 2 > buf.length) throw refuse('서명 블록(PKCS#7)이 잘렸습니다.');
  let length = buf[at + 1], head = 2;
  if (length & 0x80) {
    const bytes = length & 0x7f;
    if (!bytes || bytes > 4 || at + 2 + bytes > buf.length) throw refuse('서명 블록(PKCS#7)을 읽지 못했습니다.');
    length = 0;
    for (let index = 0; index < bytes; index++) length = length * 256 + buf[at + 2 + index];
    head += bytes;
  }
  if (at + head + length > buf.length) throw refuse('서명 블록(PKCS#7)이 잘렸습니다.');
  return { tag: buf[at], start: at, body: at + head, end: at + head + length };
}
function children(buf, node) {
  const out = [];
  for (let at = node.body; at < node.end;) { const child = tlv(buf, at); out.push(child); at = child.end; }
  return out;
}
/** ContentInfo → [0] SignedData → certificates [0] → the first certificate's DER, hashed. */
function certificateDigest(buf) {
  const explicit = children(buf, tlv(buf, 0)).find((node) => node.tag === 0xa0);
  const signedData = explicit && children(buf, explicit)[0];
  const certificates = signedData && children(buf, signedData).find((node) => node.tag === 0xa0);
  const cert = certificates && children(buf, certificates)[0];
  if (!cert) throw refuse('서명 블록에 인증서가 없습니다.');
  return createHash('sha256').update(buf.subarray(cert.start, cert.end)).digest('hex');
}

/** { format: 'aab'|'apk', sha256, size, packageName, versionCode, signingCertSha256|null } of `file`. */
export async function readBuildIdentity(file) {
  const handle = await fs.open(file, FS.O_RDONLY | (FS.O_NOFOLLOW || 0) | (FS.O_NONBLOCK || 0)); // a FIFO never blocks the read
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 22) throw refuse('zip 형식(AAB/APK)이 아닙니다.');
    const entries = await zipEntries(handle, stat.size);
    const format = entries.has(AAB_MANIFEST) ? 'aab' : entries.has(APK_MANIFEST) ? 'apk' : null;
    if (!format) throw refuse('AndroidManifest가 없어 AAB/APK로 읽을 수 없습니다.');
    const manifest = await entryData(handle, entries.get(format === 'aab' ? AAB_MANIFEST : APK_MANIFEST));
    const { packageName, versionCode } = format === 'aab' ? protoManifest(manifest) : binaryManifest(manifest);
    const signature = [...entries.keys()].find((name) => SIGNATURE.test(name));
    const signingCertSha256 = signature ? certificateDigest(await entryData(handle, entries.get(signature))) : null;
    return { format, sha256: await digest(handle, stat.size), size: stat.size, packageName, versionCode, signingCertSha256 };
  } finally { await handle.close(); }
}
