/**
 * dsh-pypi-flow -- browser client bundle.
 *
 * Served verbatim by the DSH web client and loaded through
 * `window.__ModuleLoader__`, so this file is NOT an ES module even though the
 * package itself is ESM. It must therefore stay free of `import`/`export`
 * statements, JSX, and any runtime dependency other than the `react` instance
 * the host passes to the factory.
 *
 * It registers exactly one slot: a `settings.section` panel with id
 * `pypi-flow`, offering account binding, the tracked project list, a PyPI
 * package lookup, and usage notes. Every network call goes through
 * `requestJSON()` which normalises transport errors, non-JSON bodies,
 * `{ ok: false }` payloads, and non-2xx responses into a single
 * `{ ok: false, error }` shape so no call site can silently swallow a failure.
 */
window.__ModuleLoader__.load({
  id: 'dsh-pypi-flow',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    var react = require('react');
    var h = react.createElement;

    // -----------------------------------------------------------------
    // Constants
    // -----------------------------------------------------------------

    var API_BASE = '/api/dsh-pypi-flow';

    var FONT_TITLE = 13;
    var FONT_BODY = 12;
    var FONT_HINT = 11;

    var CARD_BORDER = '1px solid rgba(128,128,128,0.3)';
    var INPUT_BORDER = '1px solid rgba(128,128,128,0.3)';
    var DIVIDER_BORDER = '1px solid rgba(128,128,128,0.18)';
    var INPUT_BG = 'rgba(128,128,128,0.08)';
    var SOFT_BG = 'rgba(128,128,128,0.12)';

    /**
     * Semantic colours. Red/green stay inside tinted notice strips so they
     * remain legible on both light and dark host themes; the surrounding
     * chrome only ever uses `inherit` or neutral rgba greys.
     */
    var DANGER = '#c0392b';
    var SUCCESS = '#2e8b57';

    var TONE = {
      error: { color: DANGER, background: 'rgba(192,57,43,0.10)', border: 'rgba(192,57,43,0.35)' },
      success: { color: SUCCESS, background: 'rgba(46,139,87,0.10)', border: 'rgba(46,139,87,0.35)' },
      info: { color: 'inherit', background: SOFT_BG, border: 'rgba(128,128,128,0.3)' },
    };

    // -----------------------------------------------------------------
    // Small helpers
    // -----------------------------------------------------------------

    /** @returns {string} A human readable one-liner for any thrown value. */
    function describeError(error) {
      if (error === null || error === undefined) return '未知错误';
      if (typeof error === 'string') return error;
      if (typeof error.message === 'string' && error.message) return error.message;
      return String(error);
    }

    /** @returns {string} `text` shortened to `limit` characters. */
    function clip(text, limit) {
      var value = String(text);
      if (value.length <= limit) return value;
      return value.slice(0, limit) + '…';
    }

    /** @returns {string} Fallback Chinese wording for an HTTP status code. */
    function fallbackHttpMessage(status) {
      if (status === 401 || status === 403) return '认证失败（HTTP ' + status + '）';
      if (status === 404) return '接口不存在（HTTP 404）';
      if (status === 429) return '请求过于频繁（HTTP 429）';
      if (status >= 500) return '服务端错误（HTTP ' + status + '）';
      return '请求失败（HTTP ' + status + '）';
    }

    /** @returns {string} Display form of a scalar, or an em dash when absent. */
    function display(value) {
      if (value === null || value === undefined || value === '') return '—';
      return String(value);
    }

    /** @returns {string} Counts and numbers without inventing zeros. */
    function displayCount(value) {
      if (value === null || value === undefined || value === '') return '—';
      if (typeof value === 'number' && Number.isFinite(value)) return String(value);
      return String(value);
    }

    /** @returns {string} Local date-time, tolerant of ISO strings or epochs. */
    function formatTime(value) {
      if (value === null || value === undefined || value === '') return '—';
      var date;
      if (typeof value === 'number' && Number.isFinite(value)) {
        date = new Date(value < 1e12 ? value * 1000 : value);
      } else {
        date = new Date(value);
      }
      if (Number.isNaN(date.getTime())) return String(value);
      try {
        return date.toLocaleString('zh-CN', {
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
        });
      } catch (error) {
        return date.toISOString().slice(0, 16).replace('T', ' ');
      }
    }

    /**
     * Fires one request against the plugin API and normalises every outcome.
     *
     * @param {string} path  Path below `/api/dsh-pypi-flow`.
     * @param {object} [init] Fetch init.
     * @returns {Promise<{ok: boolean, status: number, error?: string, notFound?: boolean, data?: object|null}>}
     */
    async function requestJSON(path, init) {
      var response;
      try {
        response = await fetch(API_BASE + path, init || {});
      } catch (error) {
        return { ok: false, status: 0, error: '网络请求失败：' + describeError(error) };
      }

      var raw = '';
      try {
        raw = await response.text();
      } catch (error) {
        raw = '';
      }

      var data = null;
      if (raw) {
        try {
          data = JSON.parse(raw);
        } catch (error) {
          data = null;
        }
      }

      var isObject = data !== null && typeof data === 'object' && !Array.isArray(data);

      if (isObject && data.ok === false) {
        var message = typeof data.error === 'string' && data.error
          ? data.error
          : fallbackHttpMessage(response.status);
        return {
          ok: false,
          status: response.status,
          error: message,
          notFound: data.notFound === true,
          data: data,
        };
      }

      if (response.ok) {
        return { ok: true, status: response.status, data: isObject ? data : null };
      }

      return {
        ok: false,
        status: response.status,
        error: fallbackHttpMessage(response.status) + (raw && !isObject ? '：' + clip(raw, 200) : ''),
        data: isObject ? data : null,
      };
    }

    /** @returns {Promise<object>} POST helper with JSON encoding. */
    function postJSON(path, payload) {
      return requestJSON(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload || {}),
      });
    }

    /**
     * Renders `type` with `children` spread as positional children. Passing a
     * single array instead would make React demand keys on statically written
     * children, which these layout helpers never carry.
     */
    function withChildren(type, props, children) {
      var args = [type, props];
      if (Array.isArray(children)) {
        for (var i = 0; i < children.length; i += 1) args.push(children[i]);
      } else if (children !== undefined) {
        args.push(children);
      }
      return h.apply(null, args);
    }

    // -----------------------------------------------------------------
    // Style factories
    // -----------------------------------------------------------------

    function cardStyle() {
      return {
        border: CARD_BORDER,
        borderRadius: 10,
        padding: '14px 16px',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        minWidth: 0,
      };
    }

    function inputStyle(extra) {
      var style = {
        fontFamily: 'inherit',
        fontSize: FONT_BODY,
        lineHeight: 1.5,
        color: 'inherit',
        background: INPUT_BG,
        border: INPUT_BORDER,
        borderRadius: 6,
        padding: '5px 9px',
        outline: 'none',
        minWidth: 0,
        flex: '1 1 220px',
        boxSizing: 'border-box',
        width: '100%',
      };
      return Object.assign(style, extra || {});
    }

    function buttonStyle(variant, inactive) {
      var style = {
        fontFamily: 'inherit',
        fontSize: FONT_BODY,
        lineHeight: 1.5,
        padding: '5px 12px',
        borderRadius: 6,
        border: INPUT_BORDER,
        background: 'transparent',
        color: 'inherit',
        cursor: inactive ? 'default' : 'pointer',
        opacity: inactive ? 0.5 : 1,
        whiteSpace: 'nowrap',
        flex: '0 0 auto',
      };
      if (variant === 'primary') style.background = 'rgba(128,128,128,0.18)';
      else if (variant === 'danger') style.color = DANGER;
      return style;
    }

    function badgeStyle(color, background, border) {
      return {
        fontSize: FONT_HINT,
        lineHeight: 1.5,
        padding: '1px 7px',
        borderRadius: 999,
        color: color,
        background: background,
        border: '1px solid ' + border,
        whiteSpace: 'nowrap',
        flex: '0 0 auto',
      };
    }

    // -----------------------------------------------------------------
    // Presentational primitives (no hooks, safe to reuse)
    // -----------------------------------------------------------------

    function Card(props) {
      var header = h('div', {
        style: {
          fontSize: FONT_TITLE,
          fontWeight: 600,
          lineHeight: 1.5,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          minWidth: 0,
        },
      },
        h('span', { style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, props.title),
        props.action || null
      );

      var body = [header];
      if (Array.isArray(props.children)) {
        for (var i = 0; i < props.children.length; i += 1) body.push(props.children[i]);
      } else if (props.children !== undefined && props.children !== null && props.children !== false) {
        body.push(props.children);
      }

      return withChildren('div', { style: cardStyle() }, body);
    }

    function Row(props) {
      var style = Object.assign({
        display: 'flex',
        alignItems: 'flex-end',
        gap: 8,
        flexWrap: 'wrap',
        minWidth: 0,
      }, props.style || {});
      return withChildren('div', { style: style }, props.children);
    }

    function Field(props) {
      return h('label', {
        style: {
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
          flex: '1 1 220px',
          minWidth: 0,
        },
      },
        h('span', { style: { fontSize: FONT_HINT, lineHeight: 1.5, opacity: 0.72 } }, props.label),
        props.children
      );
    }

    function Button(props) {
      var inactive = !!props.busy || !!props.disabled;
      return h('button', {
        type: 'button',
        disabled: inactive,
        title: props.title,
        onClick: inactive ? undefined : props.onClick,
        style: buttonStyle(props.variant, inactive),
      }, props.busy && props.busyText ? props.busyText : props.label);
    }

    function Notice(props) {
      if (!props.message) return null;
      var tone = TONE[props.tone] || TONE.info;
      return h('div', {
        style: {
          fontSize: FONT_HINT,
          lineHeight: 1.6,
          color: tone.color,
          background: tone.background,
          borderLeft: '2px solid ' + tone.border,
          borderRadius: 4,
          padding: '6px 9px',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        },
      }, props.message);
    }

    function Muted(props) {
      return h('div', {
        style: {
          fontSize: props.fontSize || FONT_HINT,
          lineHeight: 1.6,
          opacity: 0.72,
          minWidth: 0,
        },
      }, props.children);
    }

    // -----------------------------------------------------------------
    // 1. Account binding
    // -----------------------------------------------------------------

    function AccountCard(props) {
      var account = props.account || {};

      var usernamePair = react.useState(account.username || '');
      var username = usernamePair[0];
      var setUsername = usernamePair[1];

      var tokenPair = react.useState('');
      var token = tokenPair[0];
      var setToken = tokenPair[1];

      var busyPair = react.useState('');
      var busy = busyPair[0];
      var setBusy = busyPair[1];

      var messagePair = react.useState(null);
      var message = messagePair[0];
      var setMessage = messagePair[1];

      react.useEffect(function () {
        setUsername(account.username || '');
      }, [account.username]);

      var save = react.useCallback(async function () {
        setMessage(null);
        setBusy('save');
        try {
          var payload = { username: username.trim() };
          var entered = token.trim();
          if (entered) payload.token = entered;
          var result = await postJSON('/credentials', payload);
          if (!result.ok) {
            setMessage({ tone: 'error', text: result.error });
            return;
          }
          setToken('');
          setMessage({
            tone: 'success',
            text: entered ? '已保存：令牌已写入本机凭据库。' : '已保存用户名。',
          });
          if (props.onStateChanged) props.onStateChanged();
        } catch (error) {
          setMessage({ tone: 'error', text: '保存失败：' + describeError(error) });
        } finally {
          setBusy('');
        }
      }, [username, token, props.onStateChanged]);

      var clearToken = react.useCallback(async function () {
        setMessage(null);
        setBusy('clear');
        try {
          var result = await postJSON('/credentials', { clearToken: true });
          if (!result.ok) {
            setMessage({ tone: 'error', text: result.error });
            return;
          }
          setToken('');
          setMessage({ tone: 'success', text: '已从本机凭据库移除令牌。' });
          if (props.onStateChanged) props.onStateChanged();
        } catch (error) {
          setMessage({ tone: 'error', text: '清除失败：' + describeError(error) });
        } finally {
          setBusy('');
        }
      }, [props.onStateChanged]);

      var probe = react.useCallback(async function () {
        setMessage(null);
        setBusy('probe');
        try {
          var result = await postJSON('/probe', {});
          if (!result.ok) {
            setMessage({ tone: 'error', text: result.error });
            return;
          }
          var data = result.data || {};
          var outcome = data.result !== null && typeof data.result === 'object' ? data.result : data;
          var detail = typeof outcome.message === 'string' && outcome.message ? outcome.message : '';
          if (outcome.verified === true) {
            setMessage({ tone: 'success', text: detail || '连接正常：凭据可用。' });
          } else if (outcome.verified === false) {
            setMessage({ tone: 'error', text: detail || '连接被拒绝：请检查用户名与令牌。' });
          } else {
            setMessage({ tone: 'info', text: detail || '无法离线校验令牌，请以首次上传的结果为准。' });
          }
        } catch (error) {
          setMessage({ tone: 'error', text: '验证失败：' + describeError(error) });
        } finally {
          setBusy('');
        }
      }, []);

      var fieldsRow = h(Row, { key: 'fields' },
        h(Field, { key: 'username', label: 'PyPI 用户名' },
          h('input', {
            type: 'text',
            value: username,
            autoComplete: 'off',
            spellCheck: false,
            placeholder: '例如 yourname',
            onChange: function (event) { setUsername(event.target.value); },
            onKeyDown: function (event) { if (event.key === 'Enter') save(); },
            style: inputStyle(),
          })
        ),
        h(Field, { key: 'token', label: 'API 令牌' },
          h('input', {
            type: 'password',
            value: token,
            autoComplete: 'new-password',
            spellCheck: false,
            placeholder: account.tokenConfigured
              ? (account.tokenMasked || '已配置，不回显明文')
              : 'pypi-AgEIcHlwaS5vcmc…',
            onChange: function (event) { setToken(event.target.value); },
            onKeyDown: function (event) { if (event.key === 'Enter') save(); },
            style: inputStyle(),
          })
        )
      );

      var buttonsRow = h(Row, { key: 'buttons' },
        h(Button, {
          key: 'save',
          label: '保存',
          variant: 'primary',
          busy: busy === 'save',
          busyText: '保存中…',
          onClick: save,
        }),
        h(Button, {
          key: 'clear',
          label: '清除令牌',
          variant: 'danger',
          busy: busy === 'clear',
          busyText: '清除中…',
          onClick: clearToken,
          disabled: !account.tokenConfigured,
          title: account.tokenConfigured ? undefined : '当前没有可清除的令牌',
        }),
        h(Button, {
          key: 'probe',
          label: '验证连接',
          busy: busy === 'probe',
          busyText: '验证中…',
          onClick: probe,
        })
      );

      var statusLine = h(Muted, { key: 'status', fontSize: FONT_HINT },
        account.tokenConfigured
          ? '令牌已配置' + (account.tokenMasked ? '（' + account.tokenMasked + '）' : '') + '，只保存在本机。'
          : '尚未配置令牌；查询公开包不需要令牌，上传与读取私有项目时需要。'
      );

      var notice = h(Notice, {
        key: 'notice',
        tone: message ? message.tone : 'info',
        message: message ? message.text : '',
      });

      return h(Card, { title: '账号绑定' }, [fieldsRow, buttonsRow, statusLine, notice]);
    }

    // -----------------------------------------------------------------
    // 2. My projects
    // -----------------------------------------------------------------

    function ownershipBadge(project) {
      var owned = project ? project.ownedByMe : null;
      if (owned === true) {
        return h('span', { style: badgeStyle(SUCCESS, 'rgba(46,139,87,0.14)', 'rgba(46,139,87,0.35)') }, '本账号');
      }
      if (owned === false) {
        return h('span', { style: badgeStyle(DANGER, 'rgba(192,57,43,0.10)', 'rgba(192,57,43,0.32)') }, '非本账号');
      }
      return h('span', { style: badgeStyle('inherit', SOFT_BG, 'rgba(128,128,128,0.3)') }, '归属未知');
    }

    function ProjectsCard(props) {
      var listPair = react.useState(function () {
        return Array.isArray(props.projects) ? props.projects : [];
      });
      var projects = listPair[0];
      var setProjects = listPair[1];

      var draftPair = react.useState('');
      var draft = draftPair[0];
      var setDraft = draftPair[1];

      var actionPair = react.useState('');
      var action = actionPair[0];
      var setAction = actionPair[1];

      var messagePair = react.useState(null);
      var message = messagePair[0];
      var setMessage = messagePair[1];

      react.useEffect(function () {
        if (Array.isArray(props.projects)) setProjects(props.projects);
      }, [props.projects]);

      var removeProject = react.useCallback(async function (name) {
        setMessage(null);
        setAction('remove:' + name);
        try {
          var result = await postJSON('/projects', { action: 'remove', name: name });
          if (!result.ok) {
            setMessage({ tone: 'error', text: result.error });
            return;
          }
          var data = result.data || {};
          if (Array.isArray(data.projects)) setProjects(data.projects);
          setMessage({ tone: 'success', text: '已移除「' + name + '」。' });
        } catch (error) {
          setMessage({ tone: 'error', text: '移除失败：' + describeError(error) });
        } finally {
          setAction('');
        }
      }, []);

      var addProject = react.useCallback(async function () {
        var candidate = draft.trim();
        setMessage(null);
        if (!candidate) {
          setMessage({ tone: 'error', text: '请先输入项目名。' });
          return;
        }
        setAction('add');
        try {
          var result = await postJSON('/projects', { action: 'add', name: candidate });
          if (!result.ok) {
            if (result.notFound) {
              setMessage({ tone: 'info', text: '「' + candidate + '」在 PyPI 上尚未被占用（可用）。' });
            } else {
              setMessage({ tone: 'error', text: result.error });
            }
            return;
          }
          var data = result.data || {};
          if (Array.isArray(data.projects)) setProjects(data.projects);
          setDraft('');
          if (data.notFound === true) {
            setMessage({ tone: 'info', text: '「' + candidate + '」在 PyPI 上尚未被占用（可用），已加入追踪列表。' });
          } else if (data.lookup && data.lookup.version) {
            setMessage({ tone: 'success', text: '已添加「' + candidate + '」，最新版本 ' + data.lookup.version + '。' });
          } else {
            setMessage({ tone: 'success', text: '已添加「' + candidate + '」。' });
          }
        } catch (error) {
          setMessage({ tone: 'error', text: '添加失败：' + describeError(error) });
        } finally {
          setAction('');
        }
      }, [draft]);

      var refresh = react.useCallback(async function () {
        setMessage(null);
        setAction('refresh');
        try {
          var result = await requestJSON('/projects/refresh');
          if (!result.ok) {
            setMessage({ tone: 'error', text: result.error });
            return;
          }
          var data = result.data || {};
          if (Array.isArray(data.projects)) setProjects(data.projects);
          setMessage({
            tone: 'success',
            text: '已刷新，共 ' + (Array.isArray(data.projects) ? data.projects.length : projects.length) + ' 个项目。',
          });
        } catch (error) {
          setMessage({ tone: 'error', text: '刷新失败：' + describeError(error) });
        } finally {
          setAction('');
        }
      }, [projects.length]);

      var rows = projects.map(function (project, index) {
        var name = project && project.name ? String(project.name) : '';
        var removing = name !== '' && action === 'remove:' + name;
        var cells = [
          h('div', {
            key: 'info',
            style: { flex: '1 1 180px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 },
          },
            h('div', {
              style: {
                fontSize: FONT_TITLE,
                fontWeight: 600,
                lineHeight: 1.5,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              },
            }, name || '（未命名）'),
            h('div', { style: { fontSize: FONT_HINT, lineHeight: 1.5, opacity: 0.72 } },
              '最新版本 ' + display(project && project.latestVersion)
              + ' · 文件 ' + displayCount(project && project.fileCount) + ' 个'
              + ' · 最近上传 ' + formatTime(project && project.lastUpload)
            )
          ),
          h('div', {
            key: 'side',
            style: { display: 'flex', alignItems: 'center', gap: 8, flex: '0 0 auto' },
          },
            ownershipBadge(project),
            h(Button, {
              label: '移除',
              variant: 'danger',
              busy: removing,
              busyText: '移除中…',
              onClick: function () { if (name) removeProject(name); },
            })
          ),
        ];

        if (project && project.error) {
          cells.push(h('div', {
            key: 'error',
            style: {
              flex: '1 1 100%',
              fontSize: FONT_HINT,
              lineHeight: 1.5,
              color: DANGER,
              wordBreak: 'break-word',
            },
          }, project.error));
        }

        return withChildren('div', {
          key: name || 'project-' + index,
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            flexWrap: 'wrap',
            padding: '8px 0 9px',
            borderTop: DIVIDER_BORDER,
            minWidth: 0,
          },
        }, cells);
      });

      var list = projects.length === 0
        ? h(Muted, { fontSize: FONT_BODY }, '还没有追踪的项目。发布成功后会自动加入，也可以在下面手动添加。')
        : withChildren('div', { style: { display: 'flex', flexDirection: 'column', minWidth: 0 } }, rows);

      var addRow = h(Row, { key: 'add' },
        h(Field, { label: '添加项目名' },
          h('input', {
            type: 'text',
            value: draft,
            autoComplete: 'off',
            spellCheck: false,
            placeholder: 'PyPI 上的项目名，例如 requests',
            onChange: function (event) { setDraft(event.target.value); },
            onKeyDown: function (event) { if (event.key === 'Enter') addProject(); },
            style: inputStyle(),
          })
        ),
        h(Button, {
          label: '添加',
          variant: 'primary',
          busy: action === 'add',
          busyText: '添加中…',
          onClick: addProject,
        })
      );

      var notice = h(Notice, {
        key: 'notice',
        tone: message ? message.tone : 'info',
        message: message ? message.text : '',
      });

      return h(Card, {
        title: '我的项目（' + projects.length + '）',
        action: h(Button, {
          label: '刷新',
          busy: action === 'refresh',
          busyText: '刷新中…',
          onClick: refresh,
        }),
      }, [list, addRow, notice]);
    }

    // -----------------------------------------------------------------
    // 3. Package lookup
    // -----------------------------------------------------------------

    function renderPackageRow(label, valueElement, keyPrefix) {
      return [
        h('div', {
          key: keyPrefix + '-k',
          style: { fontSize: FONT_HINT, lineHeight: 1.6, opacity: 0.72 },
        }, label),
        h('div', {
          key: keyPrefix + '-v',
          style: { minWidth: 0, wordBreak: 'break-word', lineHeight: 1.6 },
        }, valueElement),
      ];
    }

    function LookupCard() {
      var draftPair = react.useState('');
      var draft = draftPair[0];
      var setDraft = draftPair[1];

      var busyPair = react.useState(false);
      var busy = busyPair[0];
      var setBusy = busyPair[1];

      var messagePair = react.useState(null);
      var message = messagePair[0];
      var setMessage = messagePair[1];

      var foundPair = react.useState(null);
      var found = foundPair[0];
      var setFound = foundPair[1];

      var lookup = react.useCallback(async function () {
        var name = draft.trim();
        setMessage(null);
        setFound(null);
        if (!name) {
          setMessage({ tone: 'error', text: '请输入要查询的包名。' });
          return;
        }
        setBusy(true);
        try {
          var result = await requestJSON('/lookup?name=' + encodeURIComponent(name));
          if (result.ok) {
            var data = result.data || {};
            setFound(data.package !== null && typeof data.package === 'object' ? data.package : data);
            return;
          }
          if (result.notFound) {
            setMessage({ tone: 'info', text: '该包名「' + name + '」在 PyPI 上未被占用（可用）。' });
            return;
          }
          setMessage({ tone: 'error', text: result.error });
        } catch (error) {
          setMessage({ tone: 'error', text: '查询失败：' + describeError(error) });
        } finally {
          setBusy(false);
        }
      }, [draft]);

      var resultBlock = null;
      if (found) {
        var ownerText;
        if (Array.isArray(found.owner)) {
          ownerText = found.owner.length > 0 ? found.owner.join('、') : '未披露';
        } else {
          ownerText = display(found.owner);
        }

        var cells = [];
        cells = cells.concat(renderPackageRow('包名', display(found.name), 'name'));
        cells = cells.concat(renderPackageRow('版本', display(found.version), 'version'));
        cells = cells.concat(renderPackageRow('摘要', display(found.summary), 'summary'));
        cells = cells.concat(renderPackageRow('Python 要求', display(found.requiresPython), 'python'));
        cells = cells.concat(renderPackageRow('所有者', ownerText, 'owner'));
        cells = cells.concat(renderPackageRow('发布数', displayCount(found.totalReleases), 'releases'));
        cells = cells.concat(renderPackageRow('最近上传', formatTime(found.lastUpload), 'upload'));
        cells = cells.concat(renderPackageRow('项目链接', found.projectUrl
          ? h('a', {
            href: found.projectUrl,
            target: '_blank',
            rel: 'noreferrer',
            style: { color: 'inherit', textDecorationLine: 'underline', wordBreak: 'break-all' },
          }, String(found.projectUrl))
          : '—', 'url'));

        if (found.yanked) {
          cells = cells.concat(renderPackageRow('状态', h('span', { style: { color: DANGER } }, '最新版本已被 yank（撤回）'), 'yanked'));
        }

        resultBlock = withChildren('div', {
          style: {
            display: 'grid',
            gridTemplateColumns: '96px minmax(0,1fr)',
            gap: '6px 12px',
            alignItems: 'baseline',
            fontSize: FONT_BODY,
            padding: '10px 12px',
            border: CARD_BORDER,
            borderRadius: 8,
            background: INPUT_BG,
            minWidth: 0,
          },
        }, cells);
      }

      var queryRow = h(Row, { key: 'query' },
        h(Field, { label: '包名' },
          h('input', {
            type: 'text',
            value: draft,
            autoComplete: 'off',
            spellCheck: false,
            placeholder: '例如 requests',
            onChange: function (event) { setDraft(event.target.value); },
            onKeyDown: function (event) { if (event.key === 'Enter') lookup(); },
            style: inputStyle(),
          })
        ),
        h(Button, {
          label: '查询',
          variant: 'primary',
          busy: busy,
          busyText: '查询中…',
          onClick: lookup,
        })
      );

      var notice = h(Notice, {
        key: 'notice',
        tone: message ? message.tone : 'info',
        message: message ? message.text : '',
      });

      return h(Card, { title: '包查询' }, [queryRow, notice, resultBlock]);
    }

    // -----------------------------------------------------------------
    // 4. Notes
    // -----------------------------------------------------------------

    function HintsCard(props) {
      var credentialPath = props.credentialPath || '$DSH_HOME/.credentials.yaml';
      var hints = [
        '令牌只写入本机 DSH 凭据库（' + credentialPath + '），不会进入插件配置、日志或对话内容。',
        '建议在 pypi.org「Account settings → API tokens」创建限定项目范围（Scope）的令牌，而不是无范围的全账号令牌；即便泄露，影响面也更小。',
        'PyPI 令牌只对上传接口生效，无法离线校验有效性。请以第一次真实上传（或「验证连接」探测）的结果为准。',
        '「我的项目」只保存在本机，用于聚合最新版本与最近上传时间；它不会在 PyPI 上创建或修改任何内容。',
      ];
      var items = hints.map(function (text, index) {
        return h('li', { key: 'hint-' + index, style: { margin: 0 } }, text);
      });

      var body = [
        h('ul', {
          key: 'list',
          style: {
            margin: 0,
            paddingLeft: 18,
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
            fontSize: FONT_HINT,
            lineHeight: 1.6,
            minWidth: 0,
          },
        }, items),
      ];

      if (props.defaultRepository) {
        body.push(h(Muted, { key: 'repo', fontSize: FONT_HINT },
          '默认目标仓库：' + props.defaultRepository + '（在插件配置的 defaultRepository 中修改）'));
      }

      return h(Card, { title: '说明' }, body);
    }

    // -----------------------------------------------------------------
    // Panel root
    // -----------------------------------------------------------------

    function emptySnapshot() {
      return {
        username: '',
        tokenConfigured: false,
        tokenMasked: '',
        projects: [],
        defaultRepository: '',
        credentialPath: '',
      };
    }

    function PyPIPanel() {
      var snapshotPair = react.useState(emptySnapshot);
      var snapshot = snapshotPair[0];
      var setSnapshot = snapshotPair[1];

      var loadingPair = react.useState(true);
      var loading = loadingPair[0];
      var setLoading = loadingPair[1];

      var errorPair = react.useState(null);
      var loadError = errorPair[0];
      var setLoadError = errorPair[1];

      var loadState = react.useCallback(async function () {
        setLoadError(null);
        try {
          var result = await requestJSON('/state');
          if (!result.ok) {
            setLoadError(result.error);
            return false;
          }
          var data = result.data || {};
          setSnapshot({
            username: typeof data.username === 'string' ? data.username : '',
            tokenConfigured: data.tokenConfigured === true,
            tokenMasked: typeof data.tokenMasked === 'string' ? data.tokenMasked : '',
            projects: Array.isArray(data.projects) ? data.projects : [],
            defaultRepository: typeof data.defaultRepository === 'string' ? data.defaultRepository : '',
            credentialPath: typeof data.credentialPath === 'string' ? data.credentialPath : '',
          });
          return true;
        } catch (error) {
          setLoadError('加载设置失败：' + describeError(error));
          return false;
        }
      }, []);

      react.useEffect(function () {
        var cancelled = false;
        loadState().then(function () {
          if (!cancelled) setLoading(false);
        });
        return function () {
          cancelled = true;
        };
      }, [loadState]);

      var handleStateChanged = react.useCallback(function () {
        loadState();
      }, [loadState]);

      var header = h('div', {
        key: 'header',
        style: {
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          gap: 10,
          minWidth: 0,
        },
      },
        h('div', { style: { fontSize: 14, fontWeight: 600, lineHeight: 1.5 } }, 'PyPI 工作流'),
        loading
          ? h('span', { style: { fontSize: FONT_HINT, opacity: 0.72, whiteSpace: 'nowrap' } }, '加载中…')
          : null
      );

      var blocks = [
        h(AccountCard, {
          key: 'account',
          account: snapshot,
          onStateChanged: handleStateChanged,
        }),
        h(ProjectsCard, {
          key: 'projects',
          projects: snapshot.projects,
        }),
        h(LookupCard, { key: 'lookup' }),
        h(HintsCard, {
          key: 'hints',
          credentialPath: snapshot.credentialPath,
          defaultRepository: snapshot.defaultRepository,
        }),
      ];

      var children = [header];
      if (loadError) {
        children.push(h(Notice, { key: 'load-error', tone: 'error', message: loadError }));
      }
      for (var i = 0; i < blocks.length; i += 1) children.push(blocks[i]);

      return withChildren('div', {
        style: {
          display: 'flex',
          flexDirection: 'column',
          gap: 20,
          maxWidth: 680,
          color: 'inherit',
          fontFamily: 'inherit',
          minWidth: 0,
          padding: '2px 0 8px',
        },
      }, children);
    }

    // -----------------------------------------------------------------
    // Plugin entry points
    // -----------------------------------------------------------------

    var inject = ['slots'];

    /**
     * Registers the PyPI settings panel. A failure here must never take the
     * whole client down, so everything is wrapped and reported as a warning.
     *
     * @param {object} ctx Plugin context provided by the DSH client runtime.
     */
    function apply(ctx) {
      try {
        if (!ctx || !ctx.slots
          || typeof ctx.slots.inject !== 'function'
          || typeof ctx.slots.register !== 'function') {
          throw new Error('ctx.slots is unavailable');
        }
        ctx.slots.inject('settings.section', function () {
          return ctx.slots.register({
            name: 'settings.section',
            id: 'pypi-flow',
            order: 316,
            label: function () { return 'PyPI'; },
          }, PyPIPanel);
        });
      } catch (error) {
        console.warn('[dsh-pypi-flow] settings panel registration failed:', error);
      }
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
