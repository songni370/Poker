import { pino, type Logger as PinoLogger } from 'pino'
/**
 * 服务端日志：只留「能让人看懂」的少量信息。
 *
 * 为什么需要它（用户要求「精简后台日志，不用过多元素」）：
 *   1. Fastify 默认会给**每个** HTTP 请求打两行 info（incoming request / request completed），
 *      浏览器加载一次牌桌就会刷出十几行，真正有价值的「房间/牌局/错误」全被淹没；
 *      现在通过 `disableRequestLogging: true` 关掉（见 app.ts）。
 *   2. 默认输出是一坨 JSON（pid / hostname / reqId / req / res 全在里面）。这里用
 *      `base: undefined` 去掉 pid 与主机名，messageFormat 给每行加时间戳，
 *      业务字段作为结构化数据保留——人看得懂，机器也还能 grep。
 *
 * 日志分级策略：
 *   - `info`：只记「发生了什么」——启动、建房、开局/结算、房间回收、关服；
 *   - `warn`：可恢复但要人注意的情况——前端未构建、快照不可用被关闭、等级为 warn 时忽略 info/debug；
 *   - `error`：需要立刻排查的失败——HTTP/WS 请求处理异常、监听失败、数据库迁移失败；
 *   - `LOG_LEVEL` 环境变量可调（trace/debug/info/warn/error/fatal/silent），默认 info。
 *   测试里传 `logLevel: 'silent'`（默认值）保持 `node --test` 的输出干净。
 */

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal' | 'silent'

export interface LogContext {
  [key: string]: unknown
}

/** 业务代码只依赖这个最小接口，换实现（例如写文件）不用改业务。 */
export interface Logger {
  info(message: string, context?: LogContext): void
  warn(message: string, context?: LogContext): void
  error(message: string, context?: LogContext): void
}

/** 业务层默认用的空实现：不引入日志模块的单元测试（纯引擎/纯函数）用它。 */
export const silentLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} }

/** Error → 一行文本（带类型名）；只有 message 进日志，不写堆栈。 */
function errorText(error: Error): string {
  return error.name && error.name !== 'Error' ? `${error.name}: ${error.message}` : error.message
}

function asContext(value: unknown): LogContext | undefined {
  if (value === undefined || value === null) return undefined
  if (value instanceof Error) return { detail: errorText(value) }
  if (typeof value === 'object') return value as LogContext
  return { detail: String(value) }
}

/**
 * 把上下文里的 Error 值压成一行文本。
 * 不这么做的话 pino 会按自己的错误序列化规则处理它：实测 `{ detail: new Error('x') }`
 * 会输出成 `detail: {}`（错误信息直接丢掉），排查时等于没记。
 */
function normalizeContext(context: LogContext): LogContext {
  const result: LogContext = {}
  for (const [key, value] of Object.entries(context)) {
    if (value === undefined) continue
    result[key] = value instanceof Error ? errorText(value) : value
  }
  return result
}

const LEVEL_NAMES: Record<number, string> = {
  10: 'TRACE',
  20: 'DEBUG',
  30: 'INFO',
  40: 'WARN',
  50: 'ERROR',
  60: 'FATAL',
}

function logTimestamp(value: unknown): string {
  const date = new Date(typeof value === 'number' ? value : Date.now())
  const pad = (part: number) => String(part).padStart(2, '0')
  return `[${pad(date.getUTCFullYear() % 100)}/${pad(date.getUTCMonth() + 1)}/${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} UTC]`
}

function compactValue(value: unknown): string {
  if (typeof value === 'string') return value.replace(/[\r\n]+/g, ' ')
  if (value === null || typeof value !== 'object') return String(value)
  return JSON.stringify(value)
}

function wrapLog(prefix: string, body: string): string {
  const continuation = ' '.repeat(Array.from(prefix).length)
  const lines: string[] = []
  let remaining = Array.from(body)
  let indent = prefix

  while (remaining.length > 120 - Array.from(indent).length) {
    const width = 120 - Array.from(indent).length
    const space = remaining.lastIndexOf(' ', width)
    const splitAt = space > Math.floor(width * 0.6) ? space : width
    lines.push(indent + remaining.slice(0, splitAt).join(''))
    remaining = remaining.slice(splitAt)
    while (remaining[0] === ' ') remaining = remaining.slice(1)
    indent = continuation
  }
  lines.push(indent + remaining.join(''))
  return lines.join('\n')
}

/** Pino destination shared by application and business logs, rendered as concise text. */
function textDestination(line: string): void {
  try {
    const entry = JSON.parse(line) as Record<string, unknown>
    const level = LEVEL_NAMES[Number(entry.level)] ?? 'INFO'
    const message = compactValue(entry.msg ?? '')
    const context = Object.entries(entry)
      .filter(([key]) => !['level', 'time', 'msg', 'v'].includes(key))
      .map(([key, value]) => `${key}=${compactValue(value)}`)
    const prefix = `${logTimestamp(entry.time)} ${level}: `
    process.stdout.write(`${wrapLog(prefix, `${message}${context.length ? ` ${context.join(' ')}` : ''}`)}\n`)
  } catch {
    process.stdout.write(line)
  }
}

/** Fastify uses this stream so framework logs share the business log format. */
export const textLogStream = { write: textDestination }

function pinoLogger(level: LogLevel): PinoLogger {
  return pino({ level, base: undefined, timestamp: pino.stdTimeFunctions.epochTime }, textLogStream)
}

/**
 * 包装 pino：只暴露 info/warn/error，并统一输出 UTC 时间戳和紧凑上下文。
 */
export function createLogger(level: LogLevel = 'info'): Logger {
  if (level === 'silent') return silentLogger
  const base = pinoLogger(level)
  return {
    info: (message, context) => {
      const detail = asContext(context)
      if (detail) base.info(normalizeContext(detail), message)
      else base.info(message)
    },
    warn: (message, context) => {
      const detail = asContext(context)
      if (detail) base.warn(normalizeContext(detail), message)
      else base.warn(message)
    },
    error: (message, context) => {
      const detail = asContext(context)
      if (detail) base.error(normalizeContext(detail), message)
      else base.error(message)
    },
  }
}
