/**
 * Dependency-free Python distribution fixtures for the uploader tests.
 *
 * Everything is generated at runtime into a system temporary directory: no
 * network access, no Python toolchain, no binary fixtures checked in. The zip
 * and tar writers are the minimal implementations the reader expects — a wheel
 * with a deflated METADATA, a stored-only wheel, a gzipped tar sdist and a zip
 * sdist, plus a handful of deliberately broken inputs.
 *
 * Import `createFixtures()`, use the returned paths, and call `cleanup()` when
 * done (the test file also cleans up on process exit as a safety net).
 *
 * @module dsh-pypi-flow/tests/dist-fixtures
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync, gzipSync } from 'node:zlib';

/** Zip signatures used by the writer below. */
const ZIP_LOCAL_SIGNATURE = 0x04034b50;
const ZIP_CENTRAL_SIGNATURE = 0x02014b50;
const ZIP_EOCD_SIGNATURE = 0x06054b50;
/** Size of one tar block. */
const TAR_BLOCK_SIZE = 512;

/**
 * Precomputed CRC-32 lookup table (IEEE 802.3 polynomial, reflected).
 *
 * @type {Uint32Array}
 */
const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

/**
 * Compute the CRC-32 of a buffer, as required by the zip local/central headers.
 *
 * @param {Buffer} buffer Input bytes.
 * @returns {number} Unsigned 32-bit checksum.
 */
export function crc32(buffer) {
  let crc = 0xffffffff;
  for (let index = 0; index < buffer.length; index += 1) {
    crc = CRC32_TABLE[(crc ^ buffer[index]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Coerce an entry payload to a Buffer.
 *
 * @param {Buffer|string} data Payload.
 * @returns {Buffer}
 */
function toBuffer(data) {
  return Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
}

/**
 * Build a zip archive from in-memory entries.
 *
 * Supports stored (method 0) and deflate (method 8) entries so both reader
 * paths can be exercised, and writes a real central directory plus EOCD.
 *
 * @param {Array<{name: string, data: Buffer|string, deflate?: boolean}>} entries Archive entries in order.
 * @returns {Buffer} Complete zip archive.
 */
export function buildZip(entries) {
  /** @type {Buffer[]} */
  const localChunks = [];
  /** @type {Buffer[]} */
  const centralChunks = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, 'utf8');
    const data = toBuffer(entry.data);
    const checksum = crc32(data);
    const useDeflate = entry.deflate === true;
    const method = useDeflate ? 8 : 0;
    const payload = useDeflate ? deflateRawSync(data) : data;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(ZIP_LOCAL_SIGNATURE, 0);
    local.writeUInt16LE(20, 4); // version needed to extract
    local.writeUInt16LE(0x0800, 6); // UTF-8 filename flag
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10); // modification time
    local.writeUInt16LE(0x21, 12); // modification date: 1980-01-01
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28); // extra field length

    localChunks.push(local, nameBytes, payload);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(ZIP_CENTRAL_SIGNATURE, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0x0800, 8); // UTF-8 filename flag
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12); // modification time
    central.writeUInt16LE(0x21, 14); // modification date
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30); // extra field length
    central.writeUInt16LE(0, 32); // comment length
    central.writeUInt16LE(0, 34); // disk number start
    central.writeUInt16LE(0, 36); // internal attributes
    central.writeUInt32LE(0, 38); // external attributes
    central.writeUInt32LE(offset, 42); // local header offset

    centralChunks.push(central, nameBytes);
    offset += local.length + nameBytes.length + payload.length;
  }

  const centralDirectory = Buffer.concat(centralChunks);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(ZIP_EOCD_SIGNATURE, 0);
  eocd.writeUInt16LE(0, 4); // number of this disk
  eocd.writeUInt16LE(0, 6); // disk with central directory
  eocd.writeUInt16LE(entries.length, 8); // entries on this disk
  eocd.writeUInt16LE(entries.length, 10); // total entries
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20); // archive comment length

  return Buffer.concat([Buffer.concat(localChunks), centralDirectory, eocd]);
}

/**
 * Write a NUL-terminated octal tar numeric field.
 *
 * @param {Buffer} header Tar header being built.
 * @param {number} offset Field offset.
 * @param {number} length Field length in bytes.
 * @param {number} value Value to encode.
 */
function writeTarOctal(header, offset, length, value) {
  const text = Math.trunc(value).toString(8).padStart(length - 1, '0');
  header.write(`${text}\0`, offset, length, 'latin1');
}

/**
 * Build an uncompressed ustar archive from in-memory entries.
 *
 * @param {Array<{name: string, data: Buffer|string}>} entries Archive entries in order.
 * @returns {Buffer} Complete tar archive (including the two terminating blocks).
 */
export function buildTar(entries) {
  /** @type {Buffer[]} */
  const chunks = [];

  for (const entry of entries) {
    const data = toBuffer(entry.data);
    const header = Buffer.alloc(TAR_BLOCK_SIZE, 0);

    header.write(entry.name, 0, 100, 'utf8');
    writeTarOctal(header, 100, 8, 0o644); // mode
    writeTarOctal(header, 108, 8, 0); // uid
    writeTarOctal(header, 116, 8, 0); // gid
    writeTarOctal(header, 124, 12, data.length); // size
    writeTarOctal(header, 136, 12, 0); // modification time
    header.write('        ', 148, 8, 'latin1'); // checksum placeholder: eight spaces
    header.write('0', 156, 1, 'latin1'); // typeflag: regular file
    header.write('ustar\0', 257, 6, 'latin1');
    header.write('00', 263, 2, 'latin1');
    header.write('root', 265, 32, 'utf8'); // uname
    header.write('root', 297, 32, 'utf8'); // gname

    let checksum = 0;
    for (const byte of header) checksum += byte;
    header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'latin1');

    chunks.push(header, data);
    const padding = (TAR_BLOCK_SIZE - (data.length % TAR_BLOCK_SIZE)) % TAR_BLOCK_SIZE;
    if (padding > 0) chunks.push(Buffer.alloc(padding, 0));
  }

  chunks.push(Buffer.alloc(TAR_BLOCK_SIZE * 2, 0));
  return Buffer.concat(chunks);
}

/** Core metadata shipped inside the primary fixture wheel. */
export const WHEEL_METADATA = `Metadata-Version: 2.1
Name: mypkg
Version: 1.2.3
Summary: A tiny example package for fixture tests
Home-page: https://example.com/mypkg
Author: Ada Lovelace
Author-email: ada@example.com
License: MIT
Keywords: example,fixture
Classifier: Development Status :: 4 - Beta
Classifier: Intended Audience :: Developers
Classifier: Programming Language :: Python :: 3
Classifier: License :: OSI Approved :: MIT License
Project-URL: Homepage, https://example.com/mypkg
Project-URL: Source, https://example.com/mypkg.git
Requires-Python: >=3.8
Requires-Dist: requests>=2.0
Requires-Dist: click>=8.0
Provides-Extra: dev
Platform: any
Supported-Platform: linux-x86_64
License-File: LICENSE
Dynamic: classifier
Description-Content-Type: text/markdown

# mypkg

A tiny example package used to test the zero-dependency uploader.

## Features

- Parses wheels without third-party dependencies
- Parses sdists as well
`;

/** Core metadata shipped inside the local-version fixture wheel. */
export const LOCAL_VERSION_METADATA = `Metadata-Version: 2.1
Name: mypkg
Version: 1.2.3+local.1
Summary: A tiny example package with a local version identifier
Classifier: Programming Language :: Python :: 3
Requires-Python: >=3.8

Local version build.
`;

/** Core metadata shipped inside both sdist fixtures. */
export const SDIST_PKG_INFO = `Metadata-Version: 2.1
Name: mypkg
Version: 1.2.3
Summary: A tiny example package (sdist)
Author: Ada Lovelace
License: MIT
Classifier: Development Status :: 4 - Beta
Classifier: Programming Language :: Python :: 3
Requires-Python: >=3.8
Platform: any
License-File: LICENSE

Long description for the sdist fixture.
`;

/**
 * Core metadata with RFC822 folded (continued) header lines.
 *
 * Both the single-value `Summary` and the multi-value `Classifier` are split
 * across two physical lines to prove the reader unfolds continuations instead
 * of truncating them.
 */
export const FOLDED_METADATA = `Metadata-Version: 2.1
Name: foldedpkg
Version: 0.9.0
Summary: A folded summary that continues
 across two physical lines
Classifier: Development Status :: 3 -
 Alpha
Classifier: Intended Audience :: Developers
Author: Grace Hopper
Requires-Python: >=3.9

Folded description body.
`;

/** Values the tests assert against the primary wheel fixture. */
export const WHEEL_EXPECTED = {
  name: 'mypkg',
  version: '1.2.3',
  filetype: 'bdist_wheel',
  pyversion: 'py3',
  metadataVersion: '2.1',
  summary: 'A tiny example package for fixture tests',
  requiresPython: '>=3.8',
  classifiers: [
    'Development Status :: 4 - Beta',
    'Intended Audience :: Developers',
    'Programming Language :: Python :: 3',
    'License :: OSI Approved :: MIT License',
  ],
  requiresDist: ['requests>=2.0', 'click>=8.0'],
  projectUrls: ['Homepage, https://example.com/mypkg', 'Source, https://example.com/mypkg.git'],
};

/**
 * Create every fixture inside a fresh temporary directory.
 *
 * @returns {{
 *   dir: string,
 *   wheelPath: string,
 *   localVersionWheelPath: string,
 *   foldedWheelPath: string,
 *   sdistPath: string,
 *   sdistZipPath: string,
 *   brokenWheelPath: string,
 *   noMetadataWheelPath: string,
 *   plainTextPath: string,
 *   emptyZipPath: string,
 *   missingPath: string,
 *   cleanup: () => void,
 * }} Fixture paths and their cleanup hook.
 */
export function createFixtures() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-pypi-flow-'));

  const wheelPath = join(dir, 'mypkg-1.2.3-py3-none-any.whl');
  writeFileSync(
    wheelPath,
    buildZip([
      { name: 'mypkg/__init__.py', data: "__version__ = '1.2.3'\n", deflate: true },
      // Deflated on purpose: the reader must inflate `*.dist-info/METADATA`.
      { name: 'mypkg-1.2.3.dist-info/METADATA', data: WHEEL_METADATA, deflate: true },
      {
        name: 'mypkg-1.2.3.dist-info/WHEEL',
        data: 'Wheel-Version: 1.0\nGenerator: dsh-pypi-flow-tests\nRoot-Is-Purelib: true\nTag: py3-none-any\n',
      },
      { name: 'mypkg-1.2.3.dist-info/RECORD', data: 'mypkg/__init__.py,,\n' },
    ]),
  );

  const localVersionWheelPath = join(dir, 'mypkg-1.2.3+local.1-py3-none-any.whl');
  writeFileSync(
    localVersionWheelPath,
    buildZip([
      { name: 'mypkg/__init__.py', data: "__version__ = '1.2.3+local.1'\n" },
      { name: 'mypkg-1.2.3+local.1.dist-info/METADATA', data: LOCAL_VERSION_METADATA },
    ]),
  );

  const foldedWheelPath = join(dir, 'foldedpkg-0.9.0-py3-none-any.whl');
  writeFileSync(
    foldedWheelPath,
    buildZip([
      // Stored (not deflated) so the stored-entry code path is covered too.
      { name: 'foldedpkg/__init__.py', data: "__version__ = '0.9.0'\n" },
      { name: 'foldedpkg-0.9.0.dist-info/METADATA', data: FOLDED_METADATA },
    ]),
  );

  const sdistPath = join(dir, 'mypkg-1.2.3.tar.gz');
  writeFileSync(
    sdistPath,
    gzipSync(
      buildTar([
        { name: 'mypkg-1.2.3/PKG-INFO', data: SDIST_PKG_INFO },
        { name: 'mypkg-1.2.3/setup.py', data: "from setuptools import setup\nsetup()\n" },
        { name: 'mypkg-1.2.3/mypkg/__init__.py', data: "__version__ = '1.2.3'\n" },
      ]),
    ),
  );

  const sdistZipPath = join(dir, 'mypkg-1.2.3.zip');
  writeFileSync(
    sdistZipPath,
    buildZip([
      { name: 'mypkg-1.2.3/PKG-INFO', data: SDIST_PKG_INFO },
      { name: 'mypkg-1.2.3/setup.py', data: 'from setuptools import setup\nsetup()\n' },
    ]),
  );

  const brokenWheelPath = join(dir, 'broken-1.0.0-py3-none-any.whl');
  writeFileSync(brokenWheelPath, 'this file is definitely not a zip archive\n', 'utf8');

  const noMetadataWheelPath = join(dir, 'nometa-1.0.0-py3-none-any.whl');
  writeFileSync(
    noMetadataWheelPath,
    buildZip([{ name: 'nometa/__init__.py', data: "__version__ = '1.0.0'\n" }]),
  );

  const plainTextPath = join(dir, 'notes.txt');
  writeFileSync(plainTextPath, 'not a distribution package\n', 'utf8');

  const emptyZipPath = join(dir, 'empty-1.0.0.zip');
  writeFileSync(emptyZipPath, buildZip([{ name: 'readme.txt', data: 'nothing here\n' }]));

  const missingPath = join(dir, 'missing-0.0.0-py3-none-any.whl');

  return {
    dir,
    wheelPath,
    localVersionWheelPath,
    foldedWheelPath,
    sdistPath,
    sdistZipPath,
    brokenWheelPath,
    noMetadataWheelPath,
    plainTextPath,
    emptyZipPath,
    missingPath,
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
