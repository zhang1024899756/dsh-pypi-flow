# Changelog

## 0.1.0 — 2026-11-23

首个版本。

### 查询

- `pypi_info`：项目详情，含 `ownership` 所有者、版本数、文件数、最近上传、yank 状态。
- `pypi_versions`：按上传时间倒序的版本历史，含每个版本的文件数与 yank 状态。
- `pypi_check_name`：PEP 508 名称合法性 + 当前是否被占用（明确说明"未占用 ≠ 可注册"）。
- 名称比较一律走 PEP 503 规范化，`my_pkg` / `my.pkg` / `my-pkg` 视为同一项目。

### 发布

- `pypi_publish`：内置零依赖上传器，直接构造官方 `multipart/form-data` 请求打到
  `upload.pypi.org/legacy/`。**不需要本机 Python、twine 或 pip。**
- 支持 `.whl` / `.tar.gz` / `.tgz` / `.zip`，支持指向目录批量上传。
- 自实现 zip 与 tar 读取器，从 wheel 的 `*.dist-info/METADATA` 和 sdist 的
  `PKG-INFO` 提取元数据；表单字段严格按官方规则小写、连字符换下划线、多值字段
  复数化，并处理三个特例（`platform`、`supported_platform`、`license_file`）。
- `dryRun: true` 走完全相同的代码路径但不发网络，用于预检包名/版本号/字段。
- `build: true` 可选地先执行 `python -m build`。

### 账号与凭证

- 设置面板（设置 → PyPI）：账号绑定、我的项目、包查询、使用说明。
- 令牌写入 DSH 凭据服务（`$DSH_HOME/.credentials.yaml`），不落配置、不进状态文件、
  不出现在任何返回值或日志里；面板只显示掩码。
- 支持"仅本次会话"的令牌（`sessionToken`），不落盘。
- `pypi_probe_token`：向上传接口发一个不含文件的请求判断令牌是否通过认证。
  这是基于接口行为的推断，首次真实上传仍是最终验证。

### 我的项目

- 本地追踪清单 + 逐个实时查询 + `ownership` 归属校验。
- 发布成功后自动加入清单。
- 明确说明：PyPI 没有按账号枚举项目的 API（用户主页有 JS 反爬挑战），
  所以清单是本地维护的，不声称覆盖账号下全部项目。

### 能力边界

- PyPI 不提供删除项目、删除版本或 yank 的 API（[warehouse#12934](https://github.com/pypi/warehouse/issues/12934) 仍未实现）。
  `pypi_delete_guide` 只输出规则、事实与直达管理页的链接，不假装执行删除。

### 安全

- 所有 HTTP 路由限定 loopback（127.0.0.1 / ::1），非本机请求一律 403。
- 请求体大小上限 256 KiB。
- 状态文件权限 0600。
- 工具参数在真实执行时是冻结对象，实现不使用 `delete args.x` 这类会抛错的写法。
