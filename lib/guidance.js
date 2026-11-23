/**
 * dsh-pypi-flow — model-facing announcement.
 *
 * Kept as one exported constant so the prompt text and the tools cannot drift
 * apart: every capability named here is a tool this plugin registers, and the
 * limits named here are the ones the model would otherwise assume away
 * (notably that PyPI serves no delete or yank API).
 */

/** Order of the announcement section within the tool-guidance band. */
export const SECTION_ORDER = 163

/**
 * What the model should know about this plugin before calling anything.
 *
 * Written in Chinese to match the rest of this harness's tool guidance, and
 * deliberately front-loads the boundary facts so a request like "delete my
 * PyPI release" is answered correctly instead of attempted.
 */
export const PYPI_GUIDANCE = [
  '本机已安装 dsh-pypi-flow 插件（PyPI 包工作流）：pypi_info 查询包详情、pypi_versions 列出历史版本、pypi_check_name 判断包名当前是否被占用、pypi_my_packages 查看追踪中的自有项目（含归属校验）、pypi_publish 把本地已构建的 wheel/sdist 上传到 PyPI 或 TestPyPI（内置零依赖上传器，不需要本机 Python 或 twine）、pypi_status 查看绑定状态、pypi_config 绑定账号与令牌或增删追踪项目、pypi_delete_guide 给出删除/撤回的正确路径。',
  '能力边界（务必遵守）：PyPI 官方没有提供删除项目、删除版本或 yank 的 API，这类操作只能在 pypi.org 网页上完成，因此 pypi_delete_guide 只输出事实、规则和精确链接，不要声称能代替用户执行删除。PyPI 也无法按账号枚举全部项目（用户主页有反爬挑战），"我的包"指的是本地追踪列表，插件会逐个校验 ownership 但不保证覆盖账号下所有项目。API 令牌只对上传接口生效，离线无法权威校验，首次真实上传才是最终验证。',
  '令牌纪律：令牌存放于本机 DSH 凭据库，永不出现在返回结果、日志或配置里；不要在任何回复中复述用户提供的令牌，也不要建议用户把令牌贴进对话（面板或 pypi_config 的 token 参数由用户自行填写即可）。建议使用项目范围的 token 而不是全账号 token。',
  '操作建议：pypi_publish 是真实写入 PyPI 的操作且发布后版本号不可复用，先 pypi_check_name / pypi_info 确认包名与版本号是否已存在，必要时先 dryRun: true 预检（只解析元数据、构造请求，不上传）。用户提到「PyPI / pip 包 / wheel / sdist / 上传包 / 发版 / pypi.org」时即指本插件。',
].join('\n')
