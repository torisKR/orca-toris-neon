/**
 * Tiny Android release files for tests: a zip writer, an AAB proto manifest, an APK binary-XML
 * manifest and a PKCS#7 signature block wrapping a fake certificate. Only the structure the
 * reader walks is real; the "certificate" is opaque bytes.
 */
import { deflateRawSync } from 'node:zlib';
import { createHash } from 'node:crypto';

const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };

/** entries: [{ name, data: Buffer, deflate?: boolean }] → a zip Buffer. */
export function zip(entries) {
  const locals = [], central = [];
  let offset = 0;
  for (const { name, data, deflate = false } of entries) {
    const body = deflate ? deflateRawSync(data) : data, nameBytes = Buffer.from(name);
    const common = [u16(20), u16(0), u16(deflate ? 8 : 0), u16(0), u16(0), u32(0), u32(body.length), u32(data.length), u16(nameBytes.length), u16(0)];
    const local = Buffer.concat([u32(0x04034b50), ...common, nameBytes, body]);
    central.push(Buffer.concat([u32(0x02014b50), u16(20), ...common, u16(0), u16(0), u16(0), u32(0), u32(offset), nameBytes]));
    locals.push(local);
    offset += local.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.concat([u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length), u32(directory.length), u32(offset), u16(0)]);
  return Buffer.concat([...locals, directory, end]);
}

const varint = (n) => { const out = []; do { let byte = n % 128; n = Math.floor(n / 128); if (n) byte |= 0x80; out.push(byte); } while (n); return Buffer.from(out); };
const field = (no, value) => typeof value === 'number' ? Buffer.concat([varint(no * 8), varint(value)])
  : Buffer.concat([varint(no * 8 + 2), varint(Buffer.from(value).length), Buffer.from(value)]);
const ANDROID = 'http://schemas.android.com/apk/res/android';

/** aapt2's proto XmlNode for <manifest package=… android:versionCode=…>. */
export function protoManifest({ packageName, versionCode, compiledOnly = false }) {
  const attribute = (ns, name, value, prim) => field(4, Buffer.concat([ns ? field(1, ns) : Buffer.alloc(0), field(2, name),
    compiledOnly && prim !== undefined ? Buffer.alloc(0) : field(3, value), prim === undefined ? Buffer.alloc(0) : field(6, field(7, field(6, prim)))]));
  const element = Buffer.concat([field(3, 'manifest'), attribute(ANDROID, 'versionCode', String(versionCode), versionCode), attribute(null, 'package', packageName),
    field(5, field(1, field(3, 'application')))]);
  return field(1, element);
}

/** A minimal Android binary XML manifest (UTF-16 string pool). */
export function binaryManifest({ packageName, versionCode }) {
  const strings = ['versionCode', 'package', 'manifest', ANDROID, packageName];
  const encoded = strings.map((text) => Buffer.concat([u16(text.length), Buffer.from(text, 'utf16le'), u16(0)]));
  const offsets = [];
  let at = 0;
  for (const item of encoded) { offsets.push(u32(at)); at += item.length; }
  const pad = (buf) => buf.length % 4 ? Buffer.concat([buf, Buffer.alloc(4 - buf.length % 4)]) : buf;
  const data = pad(Buffer.concat(encoded));
  const poolHeader = 28, start = poolHeader + offsets.length * 4;
  const pool = Buffer.concat([u16(0x0001), u16(poolHeader), u32(start + data.length), u32(strings.length), u32(0), u32(0), u32(start), u32(0), ...offsets, data]);
  const resMap = Buffer.concat([u16(0x0180), u16(8), u32(12), u32(0x0101021b)]);
  const attr = (name, raw, type, value) => Buffer.concat([u32(3), u32(name), u32(raw), u16(8), Buffer.from([0, type]), u32(value)]);
  const attrs = Buffer.concat([attr(0, 0xffffffff, 0x10, versionCode), attr(1, 4, 0x03, 4)]);
  const ext = Buffer.concat([u32(0xffffffff), u32(2), u16(20), u16(20), u16(2), u16(0), u16(0), u16(0)]);
  const start2 = Buffer.concat([u16(0x0102), u16(16), u32(16 + ext.length + attrs.length), u32(1), u32(0xffffffff), ext, attrs]);
  const body = Buffer.concat([pool, resMap, start2]);
  return Buffer.concat([u16(0x0003), u16(8), u32(8 + body.length), body]);
}

const der = (tag, ...parts) => {
  const body = Buffer.concat(parts);
  const len = body.length < 128 ? Buffer.from([body.length]) : body.length < 256 ? Buffer.from([0x81, body.length]) : Buffer.from([0x82, body.length >> 8, body.length & 255]);
  return Buffer.concat([Buffer.from([tag]), len, body]);
};
/** A fake X.509 certificate (a DER SEQUENCE) and its SHA-256, as keytool would print it. */
export function fakeCertificate(label = 'upload key') {
  const cert = der(0x30, der(0x30, der(0x02, Buffer.from([2])), der(0x0c, Buffer.from(label))), der(0x30, der(0x06, Buffer.from([0x2a, 0x86]))), der(0x03, Buffer.from([0, 1, 2, 3])));
  return { cert, sha256: createHash('sha256').update(cert).digest('hex') };
}
/** META-INF/*.RSA: ContentInfo → SignedData → certificates [0] → the certificate. */
export function pkcs7(cert) {
  const oid = der(0x06, Buffer.from([0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x07, 0x02]));
  const signedData = der(0x30, der(0x02, Buffer.from([1])), der(0x31), der(0x30, der(0x06, Buffer.from([0x2a]))), der(0xa0, cert), der(0x31));
  return der(0x30, oid, der(0xa0, signedData));
}

/** An AAB (or APK) Buffer with the given identity, signed by `cert` unless null. */
export function releaseFile({ format = 'aab', packageName = 'com.example.water', versionCode = 43, cert = fakeCertificate().cert, compiledOnly = false } = {}) {
  const manifest = format === 'aab'
    ? { name: 'base/manifest/AndroidManifest.xml', data: protoManifest({ packageName, versionCode, compiledOnly }), deflate: true }
    : { name: 'AndroidManifest.xml', data: binaryManifest({ packageName, versionCode }), deflate: true };
  return zip([manifest, { name: format === 'aab' ? 'base/dex/classes.dex' : 'classes.dex', data: Buffer.from('dex\n035') },
    ...(cert ? [{ name: 'META-INF/UPLOAD.RSA', data: pkcs7(cert) }] : [])]);
}
