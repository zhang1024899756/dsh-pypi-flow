# dsh-pypi-flow

简体中文 | [English](README.md)

DeepSeek Harness 的 PyPI 工作流插件：查包、查版本、查名字、发布发行包、管理账号凭证，并在「设置」里维护你自己的项目清单。

**零运行时依赖，零构建步骤。** 查询走 PyPI 公开 JSON API，发布直接构造官方 `multipart/form-data` 上传请求——**不需要本机装 Python、不需要 twine、不需要 pip**。

---

## 先说清楚能力边界

这四条是 PyPI 官方的事实，插件不会假装自己能做到：

| 你想要的 | 实际情况 | 本插件怎么做 |
|---|---|---|
| 删除某个版本 / 文件 | PyPI **没有删除 API**，只能网页操作（[warehouse#12934](https://github.com/pypi/warehouse/issues/12934) 至今未实现） | `pypi_delete_guide` 给出规则和直达管理页的链接，不假装执行 |
| 删除整个项目 | **PyPI 不支持**，项目名会按 PEP 541 永久保留 | 同上：只能删掉它的全部版本，名称仍然占用 |
| 撤回（yank）一个版本 | **没有 API**，程序化 yank 的 PR 仍未合并 | 指引到管理页勾选 Yank（比删除更推荐的替代方案） |
| 列出"我这个账号下的所有包" | PyPI 用户主页有 JS 反爬挑战，无法稳定抓取 | 维护本地「我的项目」清单，逐个用 `ownership` 校验归属 |

另外两件事值得知道：

- **API 令牌无法离线校验。** PyPI 令牌只对上传接口生效，对无效/缺失令牌和权限不足都返回同样的 `403`。插件提供 `pypi_probe_token` 做一次不上传文件的探测，那是基于接口行为的**推断**，首次真实上传才是最终验证。
- **包名"可用"不等于"能注册"。** PyPI 会保留部分名称，`pypi_check_name` 只报告"当前没人占用"。

---

## 安装

### 从 npm 安装（推荐）

包已发布到 npm 公共注册表，DSH 可直接按包名解析：

```bash
dsh plugin add dsh-pypi-flow
```

在插件管理器的「添加插件」输入框里填同一个包名也可以。当前版本：`0.1.1`。

### 从插件市场安装

本仓库自带一份符合 DSH 插件市场格式（format 1）的索引文件：

```
https://raw.githubusercontent.com/zhang1024899756/dsh-pypi-flow/main/market/index.json
```

在 DSH 的 **Discover** 页面把它添加为索引源，就能看到「PyPI 工作流」并直接安装。

> DSH 没有公共官方索引，Discover 只显示你自己添加的索引源，所以这一步是必须的。

### 从 GitHub 安装

在 DSH 里：

```
/plugin add github:zhang1024899756/dsh-pypi-flow
```

或者命令行：

```bash
dsh plugin --profile web add github:zhang1024899756/dsh-pypi-flow
```

### 重新生成市场索引

修改了 manifest 或显示信息（`locale/`、`icon.svg`）之后，用 DSH 源码里的官方生成器刷新索引：

```bash
# 在 DSH 源码 checkout 根目录执行
echo "https://github.com/zhang1024899756/dsh-pypi-flow" > plugins.txt
pnpm --filter @deepseek-ai/dsh-plugin-market-generator start \
  --input plugins.txt --output market/index.json --title "Arvin DSH plugins"
```

生成器会用 `dsh-plugin-market-index` 校验每个条目，图标按需内联为 `data:` URL。

---

## 设置面板

**设置 → PyPI** 里有四块：

1. **账号绑定** —— 填 PyPI 用户名 + API 令牌。令牌只写进本机 DSH 凭据库（`$DSH_HOME/.credentials.yaml`），面板只显示 `pypi-A****c9a1` 这样的掩码。
2. **我的项目** —— 追踪列表，每行实时显示最新版本、最近上传、文件数，以及 `ownership` 是否包含你绑定的用户名。发布成功后会自动加入清单。
3. **包查询** —— 输入包名直接看详情。
4. **提示区** —— 说明令牌去向、建议用项目范围令牌、令牌无法离线校验。

### 令牌怎么建

打开 <https://pypi.org/manage/account/token/>，选 **Scope 为具体项目**的令牌，而不是 Account-wide 令牌。项目范围令牌只能往那几个项目发布，泄露的损失小得多。

---

## 工具

| 工具 | 作用 |
|---|---|
| `pypi_status` | 绑定状态、令牌掩码、追踪项目数、最近一次发布 |
| `pypi_config` | 绑定用户名、保存/清除令牌（持久或仅本次会话）、设置默认目标、增删追踪项目 |
| `pypi_info` | 包详情：最新版本、摘要、requires_python、ownership、版本数、最近上传、是否 yank |
| `pypi_versions` | 历史版本列表（上传时间倒序，含文件数与 yank 状态） |
| `pypi_check_name` | 包名合法性 + 当前是否被占用 |
| `pypi_my_packages` | 追踪清单 + 逐个实时查询 + 归属校验 |
| `pypi_publish` | 上传 `.whl` / `.tar.gz` 到 PyPI 或 TestPyPI |
| `pypi_probe_token` | 不传文件的令牌连通性探测 |
| `pypi_delete_guide` | 删除 / yank 的正确路径与直达链接 |

### 发布

```text
pypi_publish { path: "D:/proj/dist", dryRun: true }     # 先预检：解析元数据、构造请求，不上传
pypi_publish { path: "D:/proj/dist" }                   # 真实上传
pypi_publish { path: "D:/proj", build: true }           # 先 python -m build 再上传
pypi_publish { path: "D:/proj/dist", repository: "testpypi" }
```

`path` 可以是单个文件，也可以是目录（上传其中全部发行包）。

**发布是不可逆的**：版本号一旦发布就不能复用，即使删掉了文件也升不上去。所以先 `pypi_info` 确认版本号没被占用，再 `dryRun` 预检，最后才真发。

### 构建

`build: true` 会在项目目录执行 `python -m build --outdir dist`。这一条**需要**本机有 Python 和 `build` 模块（`pip install build`）。不需要自动构建时，直接指向已有的 `dist/` 即可，那条路径不需要 Python。

---

## 凭证安全

- 令牌存在 DSH 凭据服务里，不在配置文件、不在本插件状态文件、不在对话里。
- 状态文件 `$DSH_HOME/pypi-flow.json` 只存用户名、项目清单、最近发布回执，权限 0600，**不含任何密钥**。
- 所有工具返回值、路由响应、日志都经过检查：不会出现令牌明文。
- 也可以完全不落盘：`pypi_config` 的 `sessionToken` 只存在内存里，进程结束即失效。

---

## 开发

无构建步骤：改文件即生效（本地 link 安装时）。

```bash
node tests/smoke.mjs      # host 侧 + 上传器全部测试，离线运行
node --check index.js     # 语法检查
```

仓库结构：

```
index.js            host 入口：挂 tools / routes / 系统提示
lib/store.js        账号状态 + 凭证（凭据服务 + 0600 状态文件）
lib/pypi.js         JSON API 客户端、PEP 503 名称规范化、ownership、令牌探测
lib/metadata.js     wheel / sdist 元数据解析（自实现 zip 与 tar 读取）
lib/upload.js       零依赖 multipart 上传器
lib/tools.js        9 个面向模型的工具
lib/routes.js       面板用的 loopback HTTP 接口
client.js           设置面板（浏览器模块，React.createElement）
```

设计要求：`ownership` 用于归属校验；所有名称比较都过 `normalizeProjectName()`；上传表单字段严格按官方规则做小写/下划线/复数化和三个特例（`platform`、`supported_platform`、`license_file`）。

---

## License

MIT
