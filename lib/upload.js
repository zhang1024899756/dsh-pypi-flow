/**
 * Zero-dependency uploader for the PyPI legacy upload API.
 *
 * The multipart body is assembled by hand as a list of Buffers: every form
 * field becomes a text part (multi-value fields repeat the part name) and the
 * distribution itself becomes the final `content` part. Only `node:` built-ins
 * and the runtime `fetch` are used.
 *
 * Security note: the API token is only ever written into the `Authorization`
 * header. It is never placed in the result object, a log line, or an error
 * message — every user-facing string goes through {@link sanitizeText} first.
 *
 * @module dsh-pypi-flow/lib/upload
 */

import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { readDistribution } from './metadata.js';

/** Longest server response body kept in the result, in characters. */
const MAX_RESPONSE_BODY = 2000;
/** Longest server response snippet embedded into a user-facing message. */
const MAX_DETAIL = 300;
/** Shortest secret worth redacting; shorter values would mangle unrelated text. */
const MIN_SECRET_LENGTH = 8;

/**
 * Supported repositories, with the endpoints the uploader and the host need.
 *
 * @type {Record<string, {label: string, uploadUrl: string, indexUrl: string}>}
 */
const REPOSITORIES = {
  pypi: {
    label: 'PyPI',
    uploadUrl: 'https://upload.pypi.org/legacy/',
    indexUrl: 'https://pypi.org/simple/',
  },
  testpypi: {
    label: 'TestPyPI',
    uploadUrl: 'https://test.pypi.org/legacy/',
    indexUrl: 'https://test.pypi.org/simple/',
  },
};

/**
 * Build an `Error` with a stable machine-readable `code`.
 *
 * @param {string} code Stable error code.
 * @param {string} message User-facing Chinese explanation.
 * @returns {Error}
 */
function createError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * Resolve a repository identifier to its endpoints.
 *
 * An omitted or blank identifier falls back to PyPI; anything else that is not
 * a known repository is a hard error so a typo never uploads to the wrong index.
 *
 * @param {string} [repository] `'pypi'` or `'testpypi'`.
 * @returns {{key: string, label: string, uploadUrl: string, indexUrl: string}}
 */
function resolveRepository(repository) {
  const key = typeof repository === 'string' ? repository.trim().toLowerCase() : '';
  if (key === '') return { key: 'pypi', ...REPOSITORIES.pypi };
  const found = REPOSITORIES[key];
  if (!found) {
    throw createError('EBADREPOSITORY', `未知的仓库：${repository}。可选值为 pypi 或 testpypi。`);
  }
  return { key, ...found };
}

/**
 * Resolve the upload and index URLs for a repository.
 *
 * @param {'pypi'|'testpypi'} [repository] Repository identifier, defaults to `'pypi'`.
 * @returns {{uploadUrl: string, indexUrl: string}}
 */
export function repositoryUrls(repository) {
  const { uploadUrl, indexUrl } = resolveRepository(repository);
  return { uploadUrl, indexUrl };
}

/**
 * Make a value safe to embed in a multipart header line.
 *
 * Quotes and CR/LF would break the header (and CR/LF are a header-injection
 * vector), so they are neutralized rather than escaped.
 *
 * @param {string} value Raw value.
 * @returns {string}
 */
function escapeHeaderValue(value) {
  return String(value)
    .replace(/[\r\n]+/g, ' ')
    .replace(/"/g, '%22');
}

/**
 * Replace every occurrence of the given secrets in a string.
 *
 * Only secrets long enough to be unambiguous are redacted, so a short token
 * cannot shred unrelated words.
 *
 * @param {string} text Text to clean.
 * @param {string[]} secrets Values that must never be shown.
 * @returns {string}
 */
function sanitizeText(text, secrets) {
  let cleaned = String(text ?? '');
  for (const secret of secrets) {
    if (typeof secret !== 'string' || secret.length < MIN_SECRET_LENGTH) continue;
    cleaned = cleaned.split(secret).join('***');
  }
  return cleaned;
}

/**
 * Assemble a `multipart/form-data` body for the upload API.
 *
 * @param {Record<string, string|string[]>} formFields Form fields, already normalized.
 * @param {{filename: string, data: Buffer}} file Distribution to upload.
 * @returns {{boundary: string, body: Buffer}}
 */
function buildMultipartBody(formFields, file) {
  const boundary = `----dsh-pypi-flow-${randomUUID().replace(/-/g, '')}`;
  /** @type {Buffer[]} */
  const chunks = [];

  /** @param {string} text */
  const pushText = (text) => {
    chunks.push(Buffer.from(text, 'utf8'));
  };

  for (const [fieldName, fieldValue] of Object.entries(formFields)) {
    const values = Array.isArray(fieldValue) ? fieldValue : [fieldValue];
    for (const value of values) {
      if (value === undefined || value === null) continue;
      pushText(`--${boundary}\r\n`);
      pushText(`Content-Disposition: form-data; name="${escapeHeaderValue(fieldName)}"\r\n\r\n`);
      pushText(`${String(value)}\r\n`);
    }
  }

  pushText(`--${boundary}\r\n`);
  pushText(
    `Content-Disposition: form-data; name="content"; filename="${escapeHeaderValue(file.filename)}"\r\n`,
  );
  pushText('Content-Type: application/octet-stream\r\n\r\n');
  chunks.push(file.data);
  pushText('\r\n');
  pushText(`--${boundary}--\r\n`);

  return { boundary, body: Buffer.concat(chunks) };
}

/**
 * Map an HTTP response to the error kind the caller branches on.
 *
 * @param {number} status HTTP status code.
 * @param {string} body Raw response body.
 * @returns {'auth'|'exists'|'invalid'|'server'|'unknown'}
 */
function classifyFailure(status, body) {
  const text = String(body ?? '').toLowerCase();
  if (status === 403) return 'auth';
  if (status === 400 && text.includes('already exists')) return 'exists';
  // PyPI reports a duplicate file as HTTP 400, but some proxies and mirrors use
  // 409 with the same wording.
  if (status === 409 && text.includes('already exists')) return 'exists';
  if (status >= 400 && status < 500) return 'invalid';
  if (status >= 500) return 'server';
  return 'unknown';
}

/**
 * Turn a server response into a short single-line snippet for a message.
 *
 * HTML bodies are reduced to their visible text so the user does not get a wall
 * of markup.
 *
 * @param {string} body Raw response body.
 * @returns {string|null}
 */
function describeDetail(body) {
  const text = String(body ?? '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
  if (text === '') return null;
  return text.length > MAX_DETAIL ? `${text.slice(0, MAX_DETAIL)}…` : text;
}

/**
 * Describe a thrown network error without leaking any header value.
 *
 * @param {unknown} error Error thrown by `fetch`.
 * @returns {string}
 */
function describeNetworkError(error) {
  const name = typeof error === 'object' && error !== null ? error.name : '';
  if (name === 'AbortError') return '请求已取消或超时';
  if (name === 'TimeoutError') return '请求超时';
  const cause =
    typeof error === 'object' && error !== null && typeof error.cause === 'object' ? error.cause : null;
  const code = (cause && cause.code) || (typeof error === 'object' && error !== null && error.code) || '';
  if (code) return String(code);
  const message =
    typeof error === 'object' && error !== null && typeof error.message === 'string'
      ? error.message
      : '';
  return message === '' ? '未知网络错误' : message.slice(0, MAX_DETAIL);
}

/**
 * Build the user-facing conclusion for a failed upload.
 *
 * @param {'auth'|'exists'|'invalid'|'network'|'server'|'unknown'} errorKind Failure kind.
 * @param {number} status HTTP status code.
 * @param {string} body Sanitized response body.
 * @param {string} label Repository label.
 * @returns {string}
 */
function failureMessage(errorKind, status, body, label) {
  const detail = describeDetail(body);
  switch (errorKind) {
    case 'auth':
      return `认证失败（HTTP ${status}）：${label} 拒绝了这个令牌。请确认令牌仍然有效、具有上传权限（或使用仅限本项目的项目范围令牌），并且属于 ${label}。`;
    case 'exists':
      return `上传被拒绝：${label} 上已经存在同名文件，PyPI 不允许覆盖已发布的版本。请提升版本号后重新构建，或先在网页上删除该文件。`;
    case 'invalid':
      return `上传被拒绝（HTTP ${status}）：${detail ?? '服务端认为提交的表单不合法。'}`;
    case 'server':
      return `${label} 服务端出错（HTTP ${status}），请稍后重试；持续出现时通常是仓库侧临时故障。`;
    case 'network':
      return `上传失败：无法连接 ${label}（${detail ?? '网络错误'}）。请检查网络或代理设置后重试。`;
    default:
      return `上传失败（HTTP ${status}）：${detail ?? '未知错误。'}`;
  }
}

/**
 * Upload one distribution file to PyPI or TestPyPI.
 *
 * Per-file problems — a missing file, an unknown archive layout, broken core
 * metadata, no token — resolve to an {@link UploadResult} with `ok: false` and
 * a Chinese `message`, never a rejection, so a caller publishing a whole
 * directory can report each file and keep going. Only bad arguments (no
 * `filePath`, an unknown repository) throw, because they apply to the whole
 * call rather than to one file.
 *
 * @param {object} options Upload options.
 * @param {string} options.filePath Path of the distribution to upload.
 * @param {string} [options.token] PyPI API token (`pypi-...`). Required unless `dryRun`.
 * @param {string} [options.username] Basic-auth user, defaults to `'__token__'`.
 * @param {'pypi'|'testpypi'} [options.repository] Target repository, defaults to `'pypi'`.
 * @param {boolean} [options.dryRun] Parse and build the request without sending it.
 * @param {AbortSignal} [options.signal] Cancellation signal for the request.
 * @returns {Promise<UploadResult>}
 */
export async function uploadDistribution(options) {
  const settings = options ?? {};
  const { filePath, token, username = '__token__', repository, dryRun = false, signal } = settings;

  const target = resolveRepository(repository);
  if (typeof filePath !== 'string' || filePath.trim() === '') {
    throw createError('EINVAL', '需要提供要上传的发行包文件路径。');
  }

  const secrets = typeof token === 'string' ? [token] : [];

  /**
   * Scrub every textual field of a finished result so a token can never escape
   * through a message or a response body.
   *
   * @param {UploadResult} result Completed result.
   * @returns {UploadResult}
   */
  const scrub = (result) => {
    result.message = sanitizeText(result.message, secrets);
    if (result.responseBody !== undefined) {
      result.responseBody = sanitizeText(result.responseBody, secrets);
    }
    return result;
  };

  let distribution;
  try {
    distribution = await readDistribution(filePath);
  } catch (error) {
    // A single unreadable file must not abort a multi-file publish, so a local
    // parse failure becomes that file's own result instead of a thrown error.
    // (`readDistribution` itself still throws, as the module contract requires.)
    return scrub({
      ok: false,
      status: 0,
      message: error instanceof Error ? error.message : '无法解析发行包。',
      repository: target.key,
      uploadUrl: target.uploadUrl,
      filename: basename(resolve(filePath)),
      name: '',
      version: '',
      filetype: '',
      pyversion: '',
      dryRun: Boolean(dryRun),
      fieldNames: [],
      errorKind: 'invalid',
    });
  }

  /** Identity of the parsed file, shared by every outcome below. */
  const base = {
    repository: target.key,
    uploadUrl: target.uploadUrl,
    filename: distribution.filename,
    name: distribution.name,
    version: distribution.version,
    filetype: distribution.filetype,
    pyversion: distribution.pyversion,
    dryRun: Boolean(dryRun),
    fieldNames: Object.keys(distribution.formFields),
  };

  /**
   * Merge the parsed-file identity into a partial result and scrub it.
   *
   * @param {Partial<UploadResult>} partial Result fields to merge.
   * @returns {UploadResult}
   */
  const finish = (partial) => scrub({ ok: false, status: 0, message: '', ...base, ...partial });

  if (dryRun) {
    return finish({
      ok: true,
      status: 0,
      message: `预检通过，未上传。将向 ${target.label} 提交 ${distribution.name} ${distribution.version}（${distribution.filetype}，pyversion=${distribution.pyversion}，${distribution.size} 字节）。`,
    });
  }

  if (typeof token !== 'string' || token.trim() === '') {
    return finish({
      errorKind: 'auth',
      message:
        '上传需要 PyPI API 令牌：请先在设置面板里保存令牌（形如 pypi-AgEI...），再重试这次上传。',
    });
  }

  let bytes;
  try {
    bytes = await readFile(distribution.filePath);
  } catch (error) {
    return finish({
      errorKind: 'invalid',
      message: `无法读取发行包文件：${distribution.filePath}（${error?.code ?? '未知错误'}）。`,
    });
  }
  if (bytes.length !== distribution.size) {
    return finish({
      errorKind: 'invalid',
      message: `文件在上传前被修改过（大小与解析时不同），请重新构建后重试：${distribution.filename}`,
    });
  }

  const { boundary, body } = buildMultipartBody(distribution.formFields, {
    filename: distribution.filename,
    data: bytes,
  });
  const authorization = `Basic ${Buffer.from(`${username}:${token}`, 'utf8').toString('base64')}`;

  let response;
  try {
    response = await fetch(target.uploadUrl, {
      method: 'POST',
      headers: {
        Authorization: authorization,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        Accept: 'text/plain, */*',
        'User-Agent': 'dsh-pypi-flow/0.1 (zero-dependency uploader)',
      },
      body,
      signal,
    });
  } catch (error) {
    const reason = describeNetworkError(error);
    return finish({
      ok: false,
      status: 0,
      errorKind: 'network',
      message: failureMessage('network', 0, reason, target.label),
    });
  }

  const status = Number(response?.status) || 0;
  let text = '';
  try {
    text = typeof response?.text === 'function' ? await response.text() : '';
  } catch {
    text = '';
  }
  const truncated = text.length > MAX_RESPONSE_BODY ? text.slice(0, MAX_RESPONSE_BODY) : text;

  if (status >= 200 && status < 300) {
    return finish({
      ok: true,
      status,
      message: `已上传 ${distribution.name} ${distribution.version} 到 ${target.label}（${distribution.filename}）。`,
      responseBody: truncated === '' ? undefined : truncated,
    });
  }

  const errorKind = classifyFailure(status, text);
  return finish({
    ok: false,
    status,
    errorKind,
    message: failureMessage(errorKind, status, truncated, target.label),
    responseBody: truncated === '' ? undefined : truncated,
  });
}

/**
 * Outcome of one upload attempt.
 *
 * @typedef {object} UploadResult
 * @property {boolean} ok Whether the upload succeeded (`true` also for a dry run).
 * @property {number} status HTTP status code; `0` for dry runs and network failures.
 * @property {string} message Chinese conclusion meant to be shown to the user.
 * @property {string} repository Normalized repository identifier.
 * @property {string} uploadUrl Endpoint the request was (or would be) sent to.
 * @property {string} filename Distribution basename.
 * @property {string} name Project name from the core metadata.
 * @property {string} version Version from the core metadata.
 * @property {string} filetype `bdist_wheel` or `sdist`.
 * @property {string} pyversion Wheel python tag, or `source`.
 * @property {boolean} dryRun Whether this was a dry run.
 * @property {string} [responseBody] Server response body, truncated to 2000 characters.
 * @property {'auth'|'exists'|'invalid'|'network'|'server'|'unknown'} [errorKind] Failure classification.
 * @property {string[]} fieldNames Names of the form fields that were (or would be) submitted.
 */
