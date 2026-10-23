// 生成牌桌几何 CSS：唯一来源是 src/client/components/table-geometry.ts。
// 产物 src/client/styles/table-geometry.css 由 client 入口 import，构建前自动重跑。
import { buildTableGeometryCss } from '../src/client/components/table-geometry.ts'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const target = resolve(here, '../src/client/styles/table-geometry.css')

const header = `/* 牌桌几何变量：由 src/client/components/table-geometry.ts 生成，
   改数值请改 table-geometry.ts 后重跑 npm run gen:geometry，不要直接改这段。 */
`
const css = header + buildTableGeometryCss()
writeFileSync(target, css, 'utf8')
console.log(`[gen:geometry] ${target} (${String(css.length)} bytes)`)
