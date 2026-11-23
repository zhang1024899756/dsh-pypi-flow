/**
 * dsh-pypi-flow — settings-panel geometry guards.
 *
 * These assertions exist because of a real regression (0.1.0): `inputStyle()`
 * carried `flex: '1 1 220px'` for width inside a horizontal `Row`, but the
 * inputs actually live in `Field`, which is a **column** container. Along a
 * column the flex axis is vertical, so every input was stretched into a
 * 220px-tall slab. The bug is invisible in a code review and invisible to a
 * DOM-less test, so the guard is a static one on the style factory itself.
 *
 * What is asserted is the shape of the fix, not pixel values: the control box
 * takes its height from an explicit `height`, never from a flex basis, and the
 * width flex that `Field` genuinely needs stays in `Field`.
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const source = await readFile(path.join(root, 'client.js'), 'utf8')

/**
 * Extracts a top-level function's body by brace matching, so assertions cannot
 * accidentally match a rule that lives in a neighbouring factory.
 *
 * @param {string} name Function name as written in `client.js`.
 * @returns {string} The body, braces included.
 */
function functionBody(name) {
  const start = source.indexOf(`function ${name}(`)
  assert.notEqual(start, -1, `${name} must be defined in client.js`)
  const open = source.indexOf('{', start)
  assert.notEqual(open, -1, `${name} must have a body`)
  let depth = 0
  for (let index = open; index < source.length; index += 1) {
    const char = source[index]
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return source.slice(open, index + 1)
    }
  }
  throw new Error(`${name}: unbalanced braces in client.js`)
}

test('inputStyle: 不在纵轴容器里留下 flex 基准尺寸', () => {
  const body = functionBody('inputStyle')
  assert.ok(
    !/flex\s*:/.test(body),
    'inputStyle must not declare flex — Field is a column container, so a flex basis there becomes the box height',
  )
})

test('inputStyle: 盒高由显式 height 决定', () => {
  assert.match(source, /var CONTROL_HEIGHT = 34/, 'CONTROL_HEIGHT must be the host settings-panel metric')
  assert.match(functionBody('inputStyle'), /height:\s*CONTROL_HEIGHT/, 'the input height comes from CONTROL_HEIGHT')
})

test('inputStyle: 字号、内边距与宿主设置面板一致', () => {
  assert.match(source, /var FONT_CONTROL = 13/)
  const body = functionBody('inputStyle')
  assert.match(body, /fontSize:\s*FONT_CONTROL/)
  assert.match(body, /padding:\s*'0 12px'/, 'height-driven boxes get no vertical padding')
  assert.match(body, /boxSizing:\s*'border-box'/, 'height must include the border')
})

test('buttonStyle: 与输入框同高且文字居中', () => {
  const body = functionBody('buttonStyle')
  assert.match(body, /height:\s*CONTROL_HEIGHT/, 'button and input share one height so their bottom edges line up')
  assert.match(body, /alignItems:\s*'center'/)
  assert.match(body, /justifyContent:\s*'center'/)
})

test('Field: 保留水平方向的宽度弹性', () => {
  assert.match(
    functionBody('Field'),
    /flex:\s*'1 1 220px'/,
    'Field is a flex item of the horizontal Row; the width flex belongs here, not on the input',
  )
})
