// Dependency-free single-entry ZIP extraction. GDELT's raw files are served as
// `.zip` (not gzip), and Node has no native zip reader — but a GDELT zip is
// always a SINGLE stored/deflated entry, so we parse the local-file header and
// inflate the raw deflate stream ourselves. Verified against a real 22 MB GKG
// file (method=8 deflate → 27-column TSV). This avoids shelling out to `unzip`
// (portable, no runtime dependency).
import zlib from 'node:zlib';

// Extract the first entry of a single-file ZIP buffer → Buffer (throws on a shape
// we don't support, so the caller can fall back).
export function unzipSingle(buf) {
  if (buf.length < 30 || buf.readUInt32LE(0) !== 0x04034b50) {
    throw new Error('not a zip (bad local-file signature)');
  }
  const flags = buf.readUInt16LE(6);
  const method = buf.readUInt16LE(8);
  const compSize = buf.readUInt32LE(18);
  const nameLen = buf.readUInt16LE(26);
  const extraLen = buf.readUInt16LE(28);
  const dataStart = 30 + nameLen + extraLen;

  // Bit 3 of flags = sizes live in a trailing data descriptor, so compSize here
  // can be 0. In that case inflateRaw the rest of the buffer; zlib stops at the
  // deflate stream's own end marker, ignoring the trailing descriptor + central
  // directory. When compSize is known, slice exactly (faster, safer).
  const hasDataDescriptor = (flags & 0x08) !== 0;
  if (method === 0) {
    // stored (no compression)
    const end = compSize > 0 ? dataStart + compSize : buf.length;
    return buf.subarray(dataStart, end);
  }
  if (method === 8) {
    const slice = compSize > 0 && !hasDataDescriptor ? buf.subarray(dataStart, dataStart + compSize) : buf.subarray(dataStart);
    return zlib.inflateRawSync(slice);
  }
  throw new Error(`unsupported zip compression method ${method}`);
}
