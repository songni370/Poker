/**
 * 复制文本到剪贴板（界面只关心「成了没有」）。
 *
 * 为什么单开一个模块：`navigator.clipboard` 只在**安全上下文**（https / localhost）存在。
 * 朋友之间常用的是局域网明文地址（`http://192.168.x.x:3000`），那里它是 `undefined`，
 * 直接调用会抛错、按钮看起来「点了没反应」。所以拿不到剪贴板（或权限被拒）时返回 'manual'，
 * 由界面退到「把文字选中，请你自己按 Ctrl/⌘ + C」。
 */
export type CopyResult = 'copied' | 'manual'

/** 只依赖 writeText，方便单测传一个假剪贴板进来。 */
export type ClipboardLike = { writeText: (text: string) => Promise<void> } | undefined

export async function copyText(
  text: string,
  clipboard: ClipboardLike = globalThis.navigator?.clipboard,
): Promise<CopyResult> {
  if (typeof clipboard?.writeText !== 'function') return 'manual'
  try {
    await clipboard.writeText(text)
    return 'copied'
  } catch {
    // 浏览器把剪贴板写入当敏感权限，被拒时同样退回手动复制。
    return 'manual'
  }
}
