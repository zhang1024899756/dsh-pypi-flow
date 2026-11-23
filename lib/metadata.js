/**
 * Dependency-free reader for Python distribution metadata.
 *
 * Parses wheels (`.whl`, a zip archive) and source distributions
 * (`.tar.gz` / `.tgz` / `.tar` / `.zip`) and derives the exact form fields that
 * the PyPI legacy upload API expects. Everything here is synchronous parsing on
 * a Buffer plus one asynchronous file read, so there is no build step and no
 * third-party dependency.
 *
 * Only `node:` built-ins are used. User-facing error messages are Chinese; all
 * comments are English.
 *
 * @module dsh-pypi-flow/lib/metadata
 */

import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { gunzipSync, inflateRawSync } from 'node:zlib';

/** Zip end-of-central-directory record signature ("PK\x05\x06"). */
const ZIP_EOCD_SIGNATURE = 0x06054b50;
/** Zip central directory file header signature ("PK\x01\x02"). */
const ZIP_CENTRAL_SIGNATURE = 0x02014b50;
/** Zip local file header signature ("PK\x03\x04"). */
const ZIP_LOCAL_SIGNATURE = 0x04034b50;
/** Size of one tar block, in bytes. */
const TAR_BLOCK_SIZE = 512;
/** Metadata-Version values this reader understands. */
const SUPPORTED_METADATA_VERSIONS = new Set([
  '1.0',
  '1.1',
  '1.2',
  '2.0',
  '2.1',
  '2.2',
  '2.3',
  '2.4',
]);

/**
 * Core metadata header name (lowercase) to upload form field mapping.
 *
 * Every Core Metadata field is lowercased and has its hyphens turned into
 * underscores, but three of them have explicitly documented form names that do
 * not follow the pluralization used by older clients: `Platform`,
 * `Supported-Platform` and `License-File`. `Classifier` is the only field whose
 * form name is pluralized on top of the lowercase mapping.
 *
 * `multiple` records whether the field may legitimately appear more than once,
 * which decides between a string and an array in the produced form fields.
 *
 * @type {Map<string, {field: string, multiple: boolean}>}
 */
const CORE_METADATA_FIELDS = new Map([
  ['metadata-version', { field: 'metadata_version', multiple: false }],
  ['name', { field: 'name', multiple: false }],
  ['version', { field: 'version', multiple: false }],
  ['summary', { field: 'summary', multiple: false }],
  ['description', { field: 'description', multiple: false }],
  ['description-content-type', { field: 'description_content_type', multiple: false }],
  ['keywords', { field: 'keywords', multiple: false }],
  ['home-page', { field: 'home_page', multiple: false }],
  ['download-url', { field: 'download_url', multiple: false }],
  ['author', { field: 'author', multiple: false }],
  ['author-email', { field: 'author_email', multiple: false }],
  ['maintainer', { field: 'maintainer', multiple: false }],
  ['maintainer-email', { field: 'maintainer_email', multiple: false }],
  ['license', { field: 'license', multiple: false }],
  ['license-expression', { field: 'license_expression', multiple: false }],
  ['license-file', { field: 'license_file', multiple: true }],
  ['classifier', { field: 'classifiers', multiple: true }],
  ['platform', { field: 'platform', multiple: true }],
  ['supported-platform', { field: 'supported_platform', multiple: true }],
  ['requires-python', { field: 'requires_python', multiple: false }],
  ['requires-dist', { field: 'requires_dist', multiple: true }],
  ['requires-external', { field: 'requires_external', multiple: true }],
  ['provides-dist', { field: 'provides_dist', multiple: true }],
  ['provides-extra', { field: 'provides_extra', multiple: true }],
  ['obsoletes-dist', { field: 'obsoletes_dist', multiple: true }],
  ['project-url', { field: 'project_url', multiple: true }],
  ['dynamic', { field: 'dynamic', multiple: true }],
  ['import-name', { field: 'import_name', multiple: true }],
]);

/**
 * Build an `Error` with a stable machine-readable `code` so callers can branch
 * on the failure kind while still showing `message` to the user.
 *
 * @param {string} code Stable error code, e.g. `'ENOENT'`.
 * @param {string} message User-facing Chinese explanation.
 * @returns {Error}
 */
function createError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * Normalize a project name the way PEP 503 does, for tolerant comparisons
 * between a wheel filename and the core metadata it ships with.
 *
 * @param {string} value Raw project name.
 * @returns {string}
 */
function normalizeProjectName(value) {
  return String(value).trim().toLowerCase().replace(/[-_.]+/g, '-');
}

/**
 * Locate the zip end-of-central-directory record.
 *
 * Scans backwards from the end of the buffer because the record is followed by
 * an optional archive comment of up to 65535 bytes. Two passes are made: the
 * first requires the comment length to line up exactly with the end of file,
 * the second only requires the signature (archives with trailing junk).
 *
 * @param {Buffer} buffer Whole archive.
 * @returns {number} Offset of the record, or -1 when the archive is not a zip.
 */
function findEndOfCentralDirectory(buffer) {
  const lastPossible = buffer.length - 22;
  if (lastPossible < 0) return -1;
  const firstPossible = Math.max(0, lastPossible - 0xffff);

  for (let offset = lastPossible; offset >= firstPossible; offset -= 1) {
    if (buffer.readUInt32LE(offset) !== ZIP_EOCD_SIGNATURE) continue;
    const commentLength = buffer.readUInt16LE(offset + 20);
    if (offset + 22 + commentLength === buffer.length) return offset;
  }
  for (let offset = lastPossible; offset >= firstPossible; offset -= 1) {
    if (buffer.readUInt32LE(offset) === ZIP_EOCD_SIGNATURE) return offset;
  }
  return -1;
}

/**
 * List the central directory entries of a zip archive.
 *
 * Only the fields the reader needs are kept: name, compression method, sizes
 * and the offset of the matching local header.
 *
 * @param {Buffer} buffer Whole archive.
 * @param {string} filename Archive name, used in error messages.
 * @returns {Array<{name: string, method: number, compressedSize: number, uncompressedSize: number, localOffset: number}>}
 */
function readZipEntries(buffer, filename) {
  const eocd = findEndOfCentralDirectory(buffer);
  if (eocd < 0) {
    throw createError(
      'ENOTZIP',
      `${filename} 不是有效的 zip 归档，无法作为 wheel / zip 源码分发读取。`,
    );
  }

  const totalEntries = buffer.readUInt16LE(eocd + 10);
  const directoryOffset = buffer.readUInt32LE(eocd + 16);
  const entries = [];
  let cursor = directoryOffset;

  for (let index = 0; index < totalEntries; index += 1) {
    if (cursor + 46 > buffer.length) break;
    if (buffer.readUInt32LE(cursor) !== ZIP_CENTRAL_SIGNATURE) break;

    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength);

    entries.push({ name, method, compressedSize, uncompressedSize, localOffset });
    cursor += 46 + nameLength + extraLength + commentLength;
  }

  if (entries.length === 0) {
    throw createError('ENOTZIP', `${filename} 的 zip 中央目录里没有任何文件条目。`);
  }
  return entries;
}

/**
 * Read and decompress a single zip entry.
 *
 * The local header is re-read (rather than trusting the central directory) to
 * find the real start of the payload, because the local extra field may differ
 * in length from the central one.
 *
 * @param {Buffer} buffer Whole archive.
 * @param {{name: string, method: number, compressedSize: number, localOffset: number}} entry Entry from the central directory.
 * @returns {Buffer} Uncompressed bytes.
 */
function readZipEntryData(buffer, entry) {
  const start = entry.localOffset;
  if (start + 30 > buffer.length || buffer.readUInt32LE(start) !== ZIP_LOCAL_SIGNATURE) {
    throw createError('EBADZIP', `zip 条目 ${entry.name} 的本地文件头已损坏。`);
  }

  const nameLength = buffer.readUInt16LE(start + 26);
  const extraLength = buffer.readUInt16LE(start + 28);
  const dataStart = start + 30 + nameLength + extraLength;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > buffer.length) {
    throw createError('EBADZIP', `zip 条目 ${entry.name} 的数据区超出文件末尾。`);
  }

  const payload = buffer.subarray(dataStart, dataEnd);
  if (entry.method === 0) return Buffer.from(payload);
  if (entry.method === 8) {
    try {
      return inflateRawSync(payload);
    } catch (error) {
      throw createError(
        'EBADZIP',
        `zip 条目 ${entry.name} 的 deflate 数据无法解压（${error?.code ?? '未知错误'}）。`,
      );
    }
  }
  throw createError(
    'EUNSUPPORTED',
    `zip 条目 ${entry.name} 使用了不支持的压缩方式（method=${entry.method}），只支持 stored (0) 与 deflate (8)。`,
  );
}

/**
 * Pick the best match among several candidate entry names.
 *
 * Shallower paths win, so a wheel's own `.dist-info/METADATA` beats a nested
 * copy vendored inside the package; ties are broken lexicographically to keep
 * the choice deterministic.
 *
 * @param {string[]} names Candidate entry names.
 * @returns {string|undefined}
 */
function pickShallowest(names) {
  if (names.length === 0) return undefined;
  const scored = [...names].sort((left, right) => {
    const depthDelta = left.split('/').length - right.split('/').length;
    if (depthDelta !== 0) return depthDelta;
    const lengthDelta = left.length - right.length;
    if (lengthDelta !== 0) return lengthDelta;
    return left < right ? -1 : left > right ? 1 : 0;
  });
  return scored[0];
}

/**
 * Read a NUL-terminated string from a tar header.
 *
 * @param {Buffer} header One 512-byte tar header.
 * @param {number} start Inclusive start offset.
 * @param {number} end Exclusive end offset.
 * @returns {string}
 */
function readTarString(header, start, end) {
  const slice = header.subarray(start, end);
  const nul = slice.indexOf(0);
  const bytes = nul === -1 ? slice : slice.subarray(0, nul);
  return bytes.toString('utf8');
}

/**
 * Parse a numeric tar header field.
 *
 * Tar stores numbers as NUL/space terminated octal text, but GNU tar falls back
 * to a base-256 big-endian representation with the high bit of the first byte
 * set for very large values.
 *
 * @param {Buffer} field Raw header bytes.
 * @returns {number}
 */
function parseTarNumber(field) {
  if (field.length === 0) return 0;
  if ((field[0] & 0x80) !== 0) {
    let value = 0;
    for (let index = 1; index < field.length; index += 1) {
      value = value * 256 + field[index];
    }
    return value;
  }
  const text = field.toString('latin1').replace(/\0.*$/, '').trim();
  if (text === '') return 0;
  const value = Number.parseInt(text, 8);
  return Number.isFinite(value) ? value : 0;
}

/**
 * List the entries of an uncompressed tar archive.
 *
 * Handles the ustar `prefix` field, PAX/GNU extension headers (skipped, their
 * payload is still accounted for) and GNU base-256 sizes.
 *
 * @param {Buffer} buffer Uncompressed tar archive.
 * @param {string} filename Archive name, used in error messages.
 * @returns {Array<{name: string, typeflag: string, size: number, dataStart: number}>}
 */
function readTarEntries(buffer, filename) {
  const entries = [];
  let offset = 0;

  while (offset + TAR_BLOCK_SIZE <= buffer.length) {
    const header = buffer.subarray(offset, offset + TAR_BLOCK_SIZE);
    let allZero = true;
    for (let index = 0; index < TAR_BLOCK_SIZE; index += 1) {
      if (header[index] !== 0) {
        allZero = false;
        break;
      }
    }
    if (allZero) break;

    const name = readTarString(header, 0, 100);
    const size = parseTarNumber(header.subarray(124, 136));
    const typeflagByte = header[156];
    const typeflag = typeflagByte === 0 ? '0' : String.fromCharCode(typeflagByte);
    const prefix = readTarString(header, 345, 500);
    const dataStart = offset + TAR_BLOCK_SIZE;
    const fullName = prefix === '' ? name : `${prefix}/${name}`;

    entries.push({ name: fullName, typeflag, size, dataStart });
    offset = dataStart + Math.ceil(size / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE;

    if (offset > buffer.length) {
      throw createError('EBADTAR', `${filename} 的 tar 头部声明的大小超出文件末尾。`);
    }
  }

  if (entries.length === 0) {
    throw createError('EBADTAR', `${filename} 中没有可读取的 tar 条目。`);
  }
  return entries;
}

/**
 * Split a wheel filename into its PEP 427 components.
 *
 * `{distribution}-{version}(-{build})?-{python}-{abi}-{platform}.whl`
 *
 * The python/abi/platform tags are read from the right so a version that
 * contains `+` (local version identifiers) or a build tag cannot shift them.
 * The remaining left part is returned verbatim for optional cross-checks
 * against the core metadata.
 *
 * @param {string} filename Wheel filename.
 * @returns {{prefixParts: string[], python: string, abi: string, platform: string}}
 */
function parseWheelFilename(filename) {
  if (!filename.toLowerCase().endsWith('.whl')) {
    throw createError('EBADWHEEL', `${filename} 不是 wheel 文件（缺少 .whl 后缀）。`);
  }
  const stem = filename.slice(0, -4);
  const parts = stem.split('-');
  if (parts.length < 5) {
    throw createError(
      'EBADWHEEL',
      `wheel 文件名不符合 {distribution}-{version}-{python}-{abi}-{platform}.whl 约定：${filename}`,
    );
  }
  const platform = parts[parts.length - 1];
  const abi = parts[parts.length - 2];
  const python = parts[parts.length - 3];
  if (python === '' || abi === '' || platform === '') {
    throw createError('EBADWHEEL', `wheel 文件名的 python/abi/platform 标签为空：${filename}`);
  }
  return { prefixParts: parts.slice(0, parts.length - 3), python, abi, platform };
}

/**
 * Parse an RFC822-style metadata document.
 *
 * Header continuation lines (those starting with a space or a tab) are unfolded
 * onto the previous header per RFC 5322 — the line break is dropped and the
 * leading whitespace of the continuation is kept. Everything after the first
 * blank line is the payload, which is where the long description lives.
 *
 * @param {string} text Raw METADATA / PKG-INFO text.
 * @returns {{fields: Array<{name: string, value: string}>, body: string}}
 */
function parseRfc822(text) {
  const lines = String(text).split(/\r\n|\n|\r/);
  const fields = [];
  const bodyLines = [];
  let inBody = false;

  for (const line of lines) {
    if (inBody) {
      bodyLines.push(line);
      continue;
    }
    if (line.trim() === '') {
      inBody = true;
      continue;
    }
    if (line.startsWith(' ') || line.startsWith('\t')) {
      if (fields.length > 0) fields[fields.length - 1].value += line;
      continue;
    }
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    fields.push({ name: line.slice(0, colon).trim(), value: line.slice(colon + 1) });
  }

  return {
    fields,
    body: bodyLines.join('\n').replace(/^[\r\n]+/, '').replace(/\s+$/, ''),
  };
}

/**
 * Collapse the leading/trailing whitespace of an unfolded header value.
 *
 * @param {string} value Raw value as captured by the RFC822 reader.
 * @returns {string}
 */
function cleanHeaderValue(value) {
  return String(value).replace(/^\s+/, '').replace(/\s+$/, '');
}

/**
 * Build the upload form fields for one distribution.
 *
 * Fixed identity fields come first, then every core metadata header in file
 * order. Multi-value fields become arrays, single-value fields stay strings.
 *
 * @param {object} input
 * @param {Array<{name: string, value: string}>} input.fields Parsed metadata headers.
 * @param {string} input.body Payload after the first blank line.
 * @param {string} input.name Project name from the metadata.
 * @param {string} input.version Version from the metadata.
 * @param {'bdist_wheel'|'sdist'} input.filetype Distribution type.
 * @param {string} input.pyversion Python tag, or `'source'` for sdists.
 * @param {string} input.metadataVersion Metadata-Version header.
 * @param {string} input.sha256 Hex digest of the whole file.
 * @returns {Record<string, string|string[]>}
 */
function buildFormFields(input) {
  const { fields, body, name, version, filetype, pyversion, metadataVersion, sha256 } = input;

  /** @type {Record<string, string|string[]>} */
  const formFields = {
    ':action': 'file_upload',
    protocol_version: '1',
    name,
    version,
    filetype,
    pyversion,
    metadata_version: metadataVersion,
    sha256_digest: sha256,
  };

  /** @type {Map<string, {values: string[], multiple: boolean|null}>} */
  const collected = new Map();
  let headerDescription = '';

  for (const field of fields) {
    const lowered = field.name.toLowerCase();
    const value = cleanHeaderValue(field.value);
    if (lowered === 'description') {
      if (value !== '') headerDescription = value;
      continue;
    }
    if (value === '') continue;

    const spec = CORE_METADATA_FIELDS.get(lowered);
    const fieldName = spec ? spec.field : lowered.replace(/-/g, '_');
    const existing = collected.get(fieldName);
    if (existing) {
      existing.values.push(value);
    } else {
      collected.set(fieldName, { values: [value], multiple: spec ? spec.multiple : null });
    }
  }

  for (const [fieldName, bucket] of collected) {
    // Identity fields are already written with the values validated by the caller.
    if (fieldName === 'name' || fieldName === 'version' || fieldName === 'metadata_version') {
      continue;
    }
    if (bucket.multiple === true) {
      formFields[fieldName] = bucket.values;
    } else if (bucket.multiple === false) {
      formFields[fieldName] = bucket.values[0];
    } else {
      // Unknown field: infer multiplicity from the number of occurrences.
      formFields[fieldName] = bucket.values.length > 1 ? bucket.values : bucket.values[0];
    }
  }

  // PEP 566: the payload after the blank line wins over a folded Description
  // header, and the value belongs in `description` either way.
  const description = body !== '' ? body : headerDescription;
  if (description !== '') formFields.description = description;

  return formFields;
}

/**
 * Extract the raw metadata document out of an archive.
 *
 * @param {object} input
 * @param {Buffer} input.buffer Whole file.
 * @param {string} input.filename Basename of the file.
 * @returns {{filetype: 'bdist_wheel'|'sdist', pyversion: string, metadataText: string, prefixParts: string[]|null}}
 */
function extractMetadataDocument(input) {
  const { buffer, filename } = input;
  const lower = filename.toLowerCase();
  const isGzip = buffer.length > 2 && buffer[0] === 0x1f && buffer[1] === 0x8b;
  const isZip = buffer.length >= 4 && buffer.readUInt32LE(0) === ZIP_LOCAL_SIGNATURE;

  if (lower.endsWith('.whl')) {
    if (!isZip) {
      throw createError('EBADWHEEL', `${filename} 不是有效的 wheel：wheel 必须是 zip 归档。`);
    }
    const tags = parseWheelFilename(filename);
    const entries = readZipEntries(buffer, filename);
    const candidates = entries
      .filter((entry) => /(^|\/)[^/]+\.dist-info\/METADATA$/.test(entry.name))
      .map((entry) => entry.name);
    const chosen = pickShallowest(candidates);
    if (chosen === undefined) {
      throw createError(
        'ENOTDIST',
        `${filename} 不是有效的 wheel：归档里没有 *.dist-info/METADATA 文件。`,
      );
    }
    const entry = entries.find((candidate) => candidate.name === chosen);
    return {
      filetype: 'bdist_wheel',
      pyversion: tags.python,
      metadataText: readZipEntryData(buffer, entry).toString('utf8'),
      prefixParts: tags.prefixParts,
    };
  }

  if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz') || lower.endsWith('.tar') || isGzip) {
    let tar = buffer;
    if (isGzip) {
      try {
        tar = gunzipSync(buffer);
      } catch (error) {
        throw createError(
          'EBADGZIP',
          `${filename} 的 gzip 数据无法解压（${error?.code ?? '未知错误'}）。`,
        );
      }
    }
    const entries = readTarEntries(tar, filename);
    const candidates = entries
      .filter((entry) => entry.typeflag === '0' || entry.typeflag === '')
      .filter((entry) => entry.name === 'PKG-INFO' || entry.name.endsWith('/PKG-INFO'))
      .map((entry) => entry.name);
    const chosen = pickShallowest(candidates);
    if (chosen === undefined) {
      throw createError(
        'ENOTDIST',
        `${filename} 不是有效的源码分发：tar 归档里没有 PKG-INFO 文件。`,
      );
    }
    const entry = entries.find((candidate) => candidate.name === chosen);
    const data = tar.subarray(entry.dataStart, entry.dataStart + entry.size);
    return {
      filetype: 'sdist',
      pyversion: 'source',
      metadataText: data.toString('utf8'),
      prefixParts: null,
    };
  }

  if (isZip || lower.endsWith('.zip')) {
    const entries = readZipEntries(buffer, filename);
    const metadataNames = entries
      .filter((entry) => /(^|\/)[^/]+\.dist-info\/METADATA$/.test(entry.name))
      .map((entry) => entry.name);
    const pkgInfoNames = entries
      .filter((entry) => entry.name === 'PKG-INFO' || entry.name.endsWith('/PKG-INFO'))
      .map((entry) => entry.name);

    const chosenPkgInfo = pickShallowest(pkgInfoNames);
    if (chosenPkgInfo !== undefined) {
      const entry = entries.find((candidate) => candidate.name === chosenPkgInfo);
      return {
        filetype: 'sdist',
        pyversion: 'source',
        metadataText: readZipEntryData(buffer, entry).toString('utf8'),
        prefixParts: null,
      };
    }

    if (pickShallowest(metadataNames) !== undefined) {
      throw createError(
        'EBADWHEEL',
        `${filename} 看起来是 wheel（含 *.dist-info/METADATA），但扩展名不是 .whl，无法确定 pyversion。请改名为 .whl 后重试。`,
      );
    }

    throw createError(
      'ENOTDIST',
      `${filename} 不是有效的 Python 发行包：既没有 *.dist-info/METADATA，也没有 PKG-INFO 文件。`,
    );
  }

  throw createError(
    'EUNSUPPORTED',
    `不支持的发行包类型：${filename}。支持的格式为 .whl、.tar.gz、.tgz、.tar、.zip。`,
  );
}

/**
 * Read a distribution and describe it in the shape the uploader needs.
 *
 * @param {string} filePath Path to the `.whl` / `.tar.gz` / `.tgz` / `.tar` / `.zip` file.
 * @returns {Promise<DistMetadata>} Throws an `Error` whose `message` is safe to show to the user.
 */
export async function readDistribution(filePath) {
  if (typeof filePath !== 'string' || filePath.trim() === '') {
    throw createError('EINVAL', '需要提供发行包文件路径（.whl / .tar.gz / .tgz / .tar / .zip）。');
  }

  const absolutePath = resolve(filePath);

  let info;
  try {
    info = await stat(absolutePath);
  } catch {
    throw createError('ENOENT', `找不到发行包文件：${absolutePath}`);
  }
  if (!info.isFile()) {
    throw createError('ENOTFILE', `这不是一个文件：${absolutePath}`);
  }

  let buffer;
  try {
    buffer = await readFile(absolutePath);
  } catch (error) {
    throw createError('EREAD', `无法读取文件：${absolutePath}（${error?.code ?? '未知错误'}）。`);
  }
  if (buffer.length === 0) {
    throw createError('EEMPTY', `文件是空的：${absolutePath}`);
  }

  const filename = basename(absolutePath);
  const document = extractMetadataDocument({ buffer, filename });
  const { fields, body } = parseRfc822(document.metadataText);

  /**
   * @param {string} header Lowercase header name.
   * @returns {string[]}
   */
  const valuesOf = (header) =>
    fields
      .filter((field) => field.name.toLowerCase() === header)
      .map((field) => cleanHeaderValue(field.value))
      .filter((value) => value !== '');

  const name = valuesOf('name')[0];
  if (!name) {
    throw createError('EBADMETADATA', `${filename} 的元数据缺少 Name 字段，无法作为发行包上传。`);
  }
  const version = valuesOf('version')[0];
  if (!version) {
    throw createError('EBADMETADATA', `${filename} 的元数据缺少 Version 字段，无法作为发行包上传。`);
  }

  const warnings = [];
  let metadataVersion = valuesOf('metadata-version')[0] ?? '';
  if (metadataVersion === '') {
    metadataVersion = '2.1';
    warnings.push('元数据缺少 Metadata-Version，已按 2.1 处理。');
  } else if (!SUPPORTED_METADATA_VERSIONS.has(metadataVersion)) {
    warnings.push(
      `元数据的 Metadata-Version 是 ${metadataVersion}，超出本工具已知的 1.0–2.4 范围，仍按原值上传。`,
    );
  }

  if (document.prefixParts !== null && document.prefixParts.length > 0) {
    const filenameName = document.prefixParts[0];
    if (normalizeProjectName(filenameName) !== normalizeProjectName(name)) {
      warnings.push(
        `wheel 文件名里的项目名（${filenameName}）与元数据里的 Name（${name}）不一致。`,
      );
    }
    if (document.prefixParts.length === 2) {
      const filenameVersion = document.prefixParts[1];
      if (filenameVersion !== version) {
        warnings.push(
          `wheel 文件名里的版本（${filenameVersion}）与元数据里的 Version（${version}）不一致。`,
        );
      }
    }
  }

  const sha256 = createHash('sha256').update(buffer).digest('hex');
  const formFields = buildFormFields({
    fields,
    body,
    name,
    version,
    filetype: document.filetype,
    pyversion: document.pyversion,
    metadataVersion,
    sha256,
  });

  if (formFields.summary === undefined) {
    warnings.push('元数据缺少 Summary，PyPI 项目页上的摘要会显示为空白。');
  }

  return {
    filePath: absolutePath,
    filename,
    filetype: document.filetype,
    pyversion: document.pyversion,
    name,
    version,
    metadataVersion,
    summary: /** @type {string} */ (formFields.summary ?? ''),
    requiresPython: /** @type {string} */ (formFields.requires_python ?? ''),
    sha256,
    size: buffer.length,
    formFields,
    warnings,
  };
}

/**
 * Description of a parsed distribution, in the shape the host tools consume.
 *
 * @typedef {object} DistMetadata
 * @property {string} filePath Absolute path of the distribution file.
 * @property {string} filename Basename, e.g. `my_pkg-1.0.0-py3-none-any.whl`.
 * @property {'bdist_wheel'|'sdist'} filetype Distribution type accepted by PyPI.
 * @property {string} pyversion Wheel python tag (e.g. `py3`, `cp311`); `'source'` for sdists.
 * @property {string} name `Name` from the core metadata.
 * @property {string} version `Version` from the core metadata.
 * @property {string} metadataVersion `Metadata-Version` as found in the file.
 * @property {string} summary `Summary`, or an empty string.
 * @property {string} requiresPython `Requires-Python`, or an empty string.
 * @property {string} sha256 Hex SHA-256 of the whole file.
 * @property {number} size File size in bytes.
 * @property {Record<string, string|string[]>} formFields Every upload form field except `content`.
 * @property {string[]} warnings Non-fatal problems worth surfacing to the user.
 */
