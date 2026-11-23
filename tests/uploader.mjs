/**
 * Unit tests for `lib/metadata.js` and `lib/upload.js`.
 *
 * Self-contained: no network access, no Python toolchain, no third-party
 * dependency. Run directly with `node tests/uploader.mjs`, with
 * `node --test tests/uploader.mjs`, or import it from `tests/smoke.mjs`.
 *
 * HTTP behaviour is exercised by stubbing `globalThis.fetch`, so the real
 * multipart body, the real Authorization header and the real error mapping all
 * run — only the socket is replaced.
 *
 * @module dsh-pypi-flow/tests/uploader
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import test from 'node:test';

import { readDistribution } from '../lib/metadata.js';
import { repositoryUrls, uploadDistribution } from '../lib/upload.js';
import { WHEEL_EXPECTED, createFixtures } from './dist-fixtures.mjs';

/** Token used by the HTTP tests; long enough to look real, never valid. */
const TEST_TOKEN = 'pypi-AgEIcHlwaS5vcmcFIXTUREONLYTOKEN';

/** Lazily created fixture set, shared by every test in this file. */
let fixtures = null;

/**
 * @returns {ReturnType<typeof createFixtures>}
 */
function getFixtures() {
  if (fixtures === null) fixtures = createFixtures();
  return fixtures;
}

// Safety net: the temporary directory goes away even if a test throws.
process.on('exit', () => {
  if (fixtures === null) return;
  try {
    fixtures.cleanup();
  } catch {
    // Best effort only; the OS reclaims the temp directory anyway.
  }
});

/**
 * Run a callback with `globalThis.fetch` replaced by a stub.
 *
 * @param {(url: string, init: object) => Promise<object>|object} handler Stub implementation.
 * @param {(calls: Array<{url: string, init: object}>) => Promise<unknown>} run Body of the test.
 * @returns {Promise<unknown>}
 */
async function withStubbedFetch(handler, run) {
  const original = globalThis.fetch;
  /** @type {Array<{url: string, init: object}>} */
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init);
  };
  try {
    return await run(calls);
  } finally {
    globalThis.fetch = original;
  }
}

/**
 * Build a `fetch`-shaped response object.
 *
 * @param {number} status HTTP status code.
 * @param {string} body Response body.
 * @returns {{status: number, ok: boolean, text: () => Promise<string>}}
 */
function fakeResponse(status, body) {
  return { status, ok: status >= 200 && status < 300, text: async () => body };
}

/**
 * Assert that no serialized part of a value contains the test token.
 *
 * @param {unknown} value Anything JSON-serializable.
 */
function assertNoToken(value) {
  assert.equal(
    JSON.stringify(value).includes(TEST_TOKEN),
    false,
    '结果里出现了 token 明文，违反安全红线',
  );
}

/**
 * Extract the multipart boundary from a `Content-Type` header value.
 *
 * @param {string} contentType Header value.
 * @returns {string}
 */
function boundaryOf(contentType) {
  const match = /boundary=(.+)$/.exec(contentType);
  assert.ok(match, `Content-Type 里没有 boundary：${contentType}`);
  return match[1];
}

test('wheel: 解析出 name/version/filetype/pyversion/sha256/size', async () => {
  const { wheelPath } = getFixtures();
  const metadata = await readDistribution(wheelPath);

  assert.equal(metadata.name, WHEEL_EXPECTED.name);
  assert.equal(metadata.version, WHEEL_EXPECTED.version);
  assert.equal(metadata.filetype, 'bdist_wheel');
  assert.equal(metadata.pyversion, 'py3');
  assert.equal(metadata.metadataVersion, WHEEL_EXPECTED.metadataVersion);
  assert.equal(metadata.summary, WHEEL_EXPECTED.summary);
  assert.equal(metadata.requiresPython, WHEEL_EXPECTED.requiresPython);
  assert.equal(metadata.filename, 'mypkg-1.2.3-py3-none-any.whl');
  assert.equal(metadata.filePath, wheelPath);

  const expectedSha = createHash('sha256').update(readFileSync(wheelPath)).digest('hex');
  assert.equal(metadata.sha256, expectedSha);
  assert.equal(metadata.size, statSync(wheelPath).size);
  assert.equal(metadata.formFields.sha256_digest, expectedSha);
  assert.deepEqual(metadata.warnings, []);
});

test('wheel: 固定表单字段齐全且取值正确', async () => {
  const { formFields } = await readDistribution(getFixtures().wheelPath);

  assert.equal(formFields[':action'], 'file_upload');
  assert.equal(formFields.protocol_version, '1');
  assert.equal(formFields.name, 'mypkg');
  assert.equal(formFields.version, '1.2.3');
  assert.equal(formFields.filetype, 'bdist_wheel');
  assert.equal(formFields.pyversion, 'py3');
  assert.equal(formFields.metadata_version, '2.1');
  assert.match(formFields.sha256_digest, /^[0-9a-f]{64}$/);
});

test('wheel: 多值字段是数组，单值字段是字符串', async () => {
  const { formFields } = await readDistribution(getFixtures().wheelPath);

  assert.ok(Array.isArray(formFields.classifiers));
  assert.deepEqual(formFields.classifiers, WHEEL_EXPECTED.classifiers);
  assert.ok(Array.isArray(formFields.requires_dist));
  assert.deepEqual(formFields.requires_dist, WHEEL_EXPECTED.requiresDist);
  assert.ok(Array.isArray(formFields.project_url));
  assert.deepEqual(formFields.project_url, WHEEL_EXPECTED.projectUrls);
  assert.deepEqual(formFields.provides_extra, ['dev']);
  assert.deepEqual(formFields.dynamic, ['classifier']);

  assert.equal(typeof formFields.summary, 'string');
  assert.equal(typeof formFields.author, 'string');
  assert.equal(typeof formFields.author_email, 'string');
  assert.equal(typeof formFields.requires_python, 'string');
  assert.equal(typeof formFields.license, 'string');
  assert.equal(typeof formFields.description, 'string');
});

test('wheel: 复数化与三个官方特例的键名正确', async () => {
  const { formFields } = await readDistribution(getFixtures().wheelPath);

  // Classifier 是唯一需要加 s 的字段。
  assert.equal('classifiers' in formFields, true);
  assert.equal('classifier' in formFields, false);

  // Platform / Supported-Platform / License-File 不能复数化。
  assert.deepEqual(formFields.platform, ['any']);
  assert.deepEqual(formFields.supported_platform, ['linux-x86_64']);
  assert.deepEqual(formFields.license_file, ['LICENSE']);
  assert.equal('platforms' in formFields, false);
  assert.equal('supported_platforms' in formFields, false);
  assert.equal('license_files' in formFields, false);
});

test('wheel: Description 正文归到 description 字段', async () => {
  const { formFields } = await readDistribution(getFixtures().wheelPath);

  assert.match(formFields.description, /# mypkg/);
  assert.match(formFields.description, /Parses wheels without third-party dependencies/);
  assert.match(formFields.description, /Parses sdists as well/);
  assert.equal(formFields.description_content_type, 'text/markdown');
});

test('wheel: 单值字段取值完整', async () => {
  const { formFields } = await readDistribution(getFixtures().wheelPath);
  assert.equal(formFields.keywords, 'example,fixture');
  assert.equal(formFields.home_page, 'https://example.com/mypkg');
});

test('wheel: RFC822 折叠续行被拼接回同一个字段', async () => {
  const metadata = await readDistribution(getFixtures().foldedWheelPath);

  assert.equal(metadata.name, 'foldedpkg');
  assert.equal(metadata.version, '0.9.0');
  // 续行按 RFC 5322 去掉了换行、保留续行自身的空格。
  assert.equal(metadata.summary, 'A folded summary that continues across two physical lines');
  assert.deepEqual(metadata.formFields.classifiers, [
    'Development Status :: 3 - Alpha',
    'Intended Audience :: Developers',
  ]);
  assert.equal(metadata.formFields.author, 'Grace Hopper');
  assert.match(metadata.formFields.description, /Folded description body/);
});

test('wheel: 版本号带 + 时 pyversion 仍从右侧取', async () => {
  const metadata = await readDistribution(getFixtures().localVersionWheelPath);

  assert.equal(metadata.name, 'mypkg');
  assert.equal(metadata.version, '1.2.3+local.1');
  assert.equal(metadata.pyversion, 'py3');
  assert.equal(metadata.filetype, 'bdist_wheel');
  assert.deepEqual(metadata.warnings, []);
});

test('sdist: tar.gz 解析出 filetype=sdist、pyversion=source', async () => {
  const { sdistPath } = getFixtures();
  const metadata = await readDistribution(sdistPath);

  assert.equal(metadata.name, 'mypkg');
  assert.equal(metadata.version, '1.2.3');
  assert.equal(metadata.filetype, 'sdist');
  assert.equal(metadata.pyversion, 'source');
  assert.equal(metadata.metadataVersion, '2.1');
  assert.equal(metadata.summary, 'A tiny example package (sdist)');
  assert.equal(metadata.requiresPython, '>=3.8');
  assert.equal(metadata.sha256, createHash('sha256').update(readFileSync(sdistPath)).digest('hex'));
  assert.equal(metadata.size, statSync(sdistPath).size);
  assert.deepEqual(metadata.formFields.classifiers, [
    'Development Status :: 4 - Beta',
    'Programming Language :: Python :: 3',
  ]);
  assert.deepEqual(metadata.formFields.platform, ['any']);
  assert.match(metadata.formFields.description, /Long description for the sdist fixture/);
});

test('sdist: zip 归档同样按 sdist 处理', async () => {
  const metadata = await readDistribution(getFixtures().sdistZipPath);

  assert.equal(metadata.filetype, 'sdist');
  assert.equal(metadata.pyversion, 'source');
  assert.equal(metadata.name, 'mypkg');
  assert.equal(metadata.version, '1.2.3');
});

test('repositoryUrls: pypi 与 testpypi 的地址正确', () => {
  assert.deepEqual(repositoryUrls('pypi'), {
    uploadUrl: 'https://upload.pypi.org/legacy/',
    indexUrl: 'https://pypi.org/simple/',
  });
  assert.deepEqual(repositoryUrls('testpypi'), {
    uploadUrl: 'https://test.pypi.org/legacy/',
    indexUrl: 'https://test.pypi.org/simple/',
  });
  // 省略参数时默认 PyPI。
  assert.deepEqual(repositoryUrls(), repositoryUrls('pypi'));
  assert.throws(() => repositoryUrls('pypi.org'), /未知的仓库/);
});

test('dryRun: 不发网络请求，返回 ok/status 与字段名清单', async () => {
  const { wheelPath } = getFixtures();
  let called = false;

  await withStubbedFetch(
    () => {
      called = true;
      throw new Error('dryRun 不应发起网络请求');
    },
    async () => {
      const result = await uploadDistribution({ filePath: wheelPath, token: TEST_TOKEN, dryRun: true });

      assert.equal(result.ok, true);
      assert.equal(result.status, 0);
      assert.equal(result.dryRun, true);
      assert.equal(result.repository, 'pypi');
      assert.equal(result.uploadUrl, 'https://upload.pypi.org/legacy/');
      assert.equal(result.name, 'mypkg');
      assert.equal(result.version, '1.2.3');
      assert.equal(result.filetype, 'bdist_wheel');
      assert.equal(result.pyversion, 'py3');
      assert.equal(result.filename, 'mypkg-1.2.3-py3-none-any.whl');
      assert.match(result.message, /预检通过/);
      assert.equal(result.errorKind, undefined);
      assertNoToken(result);

      for (const fieldName of [
        ':action',
        'protocol_version',
        'name',
        'version',
        'filetype',
        'pyversion',
        'metadata_version',
        'sha256_digest',
        'classifiers',
        'requires_dist',
      ]) {
        assert.ok(result.fieldNames.includes(fieldName), `预检字段名里缺少 ${fieldName}`);
      }
      assert.equal(result.fieldNames.includes('content'), false);
    },
  );

  assert.equal(called, false, 'dryRun 调用了 fetch');
});

test('dryRun: 指向 testpypi 时 uploadUrl 跟随仓库变化', async () => {
  const result = await uploadDistribution({
    filePath: getFixtures().sdistPath,
    dryRun: true,
    repository: 'testpypi',
  });

  assert.equal(result.ok, true);
  assert.equal(result.repository, 'testpypi');
  assert.equal(result.uploadUrl, 'https://test.pypi.org/legacy/');
  assert.equal(result.filetype, 'sdist');
  assert.equal(result.pyversion, 'source');
  assert.match(result.message, /TestPyPI/);
});

test('upload: 成功时构造正确的 multipart 请求', async () => {
  const { wheelPath } = getFixtures();

  await withStubbedFetch(
    () => fakeResponse(200, 'OK'),
    async (calls) => {
      const result = await uploadDistribution({ filePath: wheelPath, token: TEST_TOKEN });

      assert.equal(result.ok, true);
      assert.equal(result.status, 200);
      assert.equal(result.repository, 'pypi');
      assert.match(result.message, /已上传 mypkg 1\.2\.3/);
      assert.equal(result.responseBody, 'OK');
      assertNoToken(result);

      assert.equal(calls.length, 1);
      const [{ url, init }] = calls;
      assert.equal(url, 'https://upload.pypi.org/legacy/');
      assert.equal(init.method, 'POST');

      const expectedBasic = Buffer.from(`__token__:${TEST_TOKEN}`, 'utf8').toString('base64');
      assert.equal(init.headers.Authorization, `Basic ${expectedBasic}`);

      const contentType = init.headers['Content-Type'];
      assert.match(contentType, /^multipart\/form-data; boundary=/);
      const boundary = boundaryOf(contentType);
      const body = Buffer.from(init.body).toString('utf8');

      // 文本字段：固定字段与 metadata 字段都在。
      assert.match(body, /name=":action"\r\n\r\nfile_upload\r\n/);
      assert.match(body, /name="protocol_version"\r\n\r\n1\r\n/);
      assert.match(body, /name="name"\r\n\r\nmypkg\r\n/);
      assert.match(body, /name="pyversion"\r\n\r\npy3\r\n/);
      assert.match(body, /name="metadata_version"\r\n\r\n2\.1\r\n/);
      // 多值字段重复同名 part。
      const classifierParts = body.match(/name="classifiers"\r\n\r\n/g) ?? [];
      assert.equal(classifierParts.length, 4);

      // 文件 part 在最后，带真实文件名与 octet-stream。
      assert.match(
        body,
        /name="content"; filename="mypkg-1\.2\.3-py3-none-any\.whl"\r\nContent-Type: application\/octet-stream\r\n\r\n/,
      );
      assert.ok(body.endsWith(`--${boundary}--\r\n`), 'multipart 没有正确的结束分隔符');

      // content part 的字节必须与磁盘上的发行包逐字节一致。
      const rawBody = Buffer.from(init.body);
      const partHeader = Buffer.from('Content-Type: application/octet-stream\r\n\r\n', 'utf8');
      const dataStart = rawBody.indexOf(partHeader) + partHeader.length;
      const terminator = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
      const dataEnd = rawBody.indexOf(terminator, dataStart);
      assert.ok(dataStart > 0 && dataEnd > dataStart, 'multipart 里找不到 content part');
      assert.deepEqual(
        rawBody.subarray(dataStart, dataEnd),
        readFileSync(wheelPath),
        'content part 的字节与发行包文件不一致',
      );
    },
  );
});

test('upload: 403 映射为 auth，且正文里的 token 被抹掉', async () => {
  const { wheelPath } = getFixtures();

  await withStubbedFetch(
    () => fakeResponse(403, `Invalid or non-existent authentication information. ${TEST_TOKEN}`),
    async () => {
      const result = await uploadDistribution({ filePath: wheelPath, token: TEST_TOKEN });

      assert.equal(result.ok, false);
      assert.equal(result.status, 403);
      assert.equal(result.errorKind, 'auth');
      assert.match(result.message, /认证失败/);
      assertNoToken(result);
      assert.match(result.responseBody, /\*\*\*/);
    },
  );
});

test('upload: 400 + already exists 映射为 exists', async () => {
  const { wheelPath } = getFixtures();

  await withStubbedFetch(
    () => fakeResponse(400, 'File already exists. See https://pypi.org/help/#file-name-reuse'),
    async () => {
      const result = await uploadDistribution({ filePath: wheelPath, token: TEST_TOKEN });

      assert.equal(result.ok, false);
      assert.equal(result.status, 400);
      assert.equal(result.errorKind, 'exists');
      assert.match(result.message, /已经存在同名文件/);
      assertNoToken(result);
    },
  );
});

test('upload: 其他 4xx 映射为 invalid', async () => {
  const { wheelPath } = getFixtures();

  await withStubbedFetch(
    () => fakeResponse(400, 'Invalid value for field "description"'),
    async () => {
      const result = await uploadDistribution({ filePath: wheelPath, token: TEST_TOKEN });

      assert.equal(result.ok, false);
      assert.equal(result.status, 400);
      assert.equal(result.errorKind, 'invalid');
      assert.match(result.message, /上传被拒绝/);
      assert.match(result.message, /description/);
    },
  );
});

test('upload: 5xx 映射为 server', async () => {
  const { wheelPath } = getFixtures();

  await withStubbedFetch(
    () => fakeResponse(503, 'Service Unavailable'),
    async () => {
      const result = await uploadDistribution({ filePath: wheelPath, token: TEST_TOKEN });

      assert.equal(result.ok, false);
      assert.equal(result.status, 503);
      assert.equal(result.errorKind, 'server');
      assert.match(result.message, /服务端出错/);
    },
  );
});

test('upload: 网络异常映射为 network', async () => {
  const { wheelPath } = getFixtures();

  await withStubbedFetch(
    () => {
      throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    },
    async () => {
      const result = await uploadDistribution({ filePath: wheelPath, token: TEST_TOKEN });

      assert.equal(result.ok, false);
      assert.equal(result.status, 0);
      assert.equal(result.errorKind, 'network');
      assert.match(result.message, /ECONNREFUSED/);
      assert.match(result.message, /无法连接/);
      assertNoToken(result);
    },
  );
});

test('upload: 缺少令牌时直接返回 auth，不发请求', async () => {
  const { wheelPath } = getFixtures();

  await withStubbedFetch(
    () => {
      throw new Error('缺少令牌时不应该发起请求');
    },
    async () => {
      const result = await uploadDistribution({ filePath: wheelPath });

      assert.equal(result.ok, false);
      assert.equal(result.status, 0);
      assert.equal(result.errorKind, 'auth');
      assert.match(result.message, /API 令牌/);
    },
  );
});

test('不存在的文件：readDistribution reject，uploadDistribution 返回失败结果', async () => {
  const { missingPath } = getFixtures();

  // 解析层按契约直接 throw。
  await assert.rejects(() => readDistribution(missingPath), /找不到发行包文件/);

  // 上传层把单文件问题收进结果，避免中断整批上传。
  const result = await uploadDistribution({ filePath: missingPath, token: TEST_TOKEN });
  assert.equal(result.ok, false);
  assert.equal(result.status, 0);
  assert.equal(result.errorKind, 'invalid');
  assert.match(result.message, /找不到发行包文件/);
  assert.equal(result.filename, 'missing-0.0.0-py3-none-any.whl');
  assert.deepEqual(result.fieldNames, []);
  assertNoToken(result);
});

test('非发行包输入：message 可读且不抛给上传层', async () => {
  const { brokenWheelPath, noMetadataWheelPath, plainTextPath, emptyZipPath } = getFixtures();

  const cases = [
    [brokenWheelPath, /不是有效的 wheel/],
    [noMetadataWheelPath, /dist-info\/METADATA/],
    [plainTextPath, /不支持的发行包类型/],
    [emptyZipPath, /既没有|PKG-INFO/],
  ];

  for (const [filePath, pattern] of cases) {
    await assert.rejects(() => readDistribution(filePath), pattern);
    const result = await uploadDistribution({ filePath, token: TEST_TOKEN });
    assert.equal(result.ok, false, `${filePath} 应该是失败结果`);
    assert.equal(result.errorKind, 'invalid');
    assert.match(result.message, pattern);
    assertNoToken(result);
  }
});

test('upload: 一个坏文件不会中断同批其他文件', async () => {
  const { wheelPath, brokenWheelPath, missingPath } = getFixtures();

  await withStubbedFetch(
    () => fakeResponse(200, 'OK'),
    async (calls) => {
      const outcomes = [];
      for (const filePath of [wheelPath, brokenWheelPath, missingPath]) {
        outcomes.push(await uploadDistribution({ filePath, token: TEST_TOKEN }));
      }

      assert.equal(outcomes[0].ok, true);
      assert.equal(outcomes[1].ok, false);
      assert.match(outcomes[1].message, /不是有效的 wheel/);
      assert.equal(outcomes[2].ok, false);
      assert.match(outcomes[2].message, /找不到发行包文件/);
      // 只有那个合法的 wheel 走到了网络层。
      assert.equal(calls.length, 1);
    },
  );
});

test('upload: 未知仓库直接抛错', async () => {
  await assert.rejects(
    () => uploadDistribution({ filePath: getFixtures().wheelPath, token: TEST_TOKEN, repository: 'pypi.org' }),
    /未知的仓库/,
  );
});
