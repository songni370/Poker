import { computed, ref } from 'vue'
import { bgmEnabled, soundEnabled, syncBgm, unlockAudio } from '../sound/index.ts'

/**
 * 顶栏「声音」控制的全部状态与行为。
 *
 * 从 `TableView.vue` 抽出，与 HUD 面板同属「顶栏工具的开关状态」，
 * 页面组件只需要知道浮层是否展开（用于点击空白收起）。
 *
 * 两条浏览器约束决定了这里的写法：
 *   - AudioContext 必须在**用户手势**里创建/恢复，所以开关点击时才 unlock；
 *   - 默认全部关闭，避免用户一进页面就被声音打扰。
 */
export function useSoundControl() {
  /** 声音设置浮层显隐（点空白处收起，由页面转发 pointerdown）。 */
  const panelOpen = ref(false)

  /** 顶栏按钮图标：关 → 静音；开 + 有 BGM → 音符；开无 BGM → 喇叭。 */
  const icon = computed(() => {
    if (!soundEnabled.value) return 'pi pi-volume-off'
    return bgmEnabled.value ? 'pi pi-volume-up' : 'pi pi-bell'
  })

  /** 无障碍名与悬停提示都带上当前状态，读屏也能听出来。 */
  const summary = computed(() => {
    const parts = [soundEnabled.value ? '音效开启' : '音效关闭']
    parts.push(bgmEnabled.value ? '背景音乐开启' : '背景音乐关闭')
    return parts.join(' · ')
  })

  function toggleSound(): void {
    soundEnabled.value = !soundEnabled.value
    // 打开音效时立刻解锁音频上下文（必须在用户手势里）。
    if (soundEnabled.value) unlockAudio()
    syncBgm()
  }

  function toggleBgm(): void {
    bgmEnabled.value = !bgmEnabled.value
    if (bgmEnabled.value && soundEnabled.value) unlockAudio()
    syncBgm()
  }

  function togglePanel(): void {
    panelOpen.value = !panelOpen.value
  }

  function closePanel(): void {
    panelOpen.value = false
  }

  /** 点击浮层外部收起；返回是否真的收起了（便于调用方决定是否继续处理该事件）。 */
  function handleOutsidePointer(target: HTMLElement | null): boolean {
    if (!panelOpen.value || !target) return false
    if (target.closest('.sound-control')) return false
    panelOpen.value = false
    return true
  }

  return {
    panelOpen,
    icon,
    summary,
    soundEnabled,
    bgmEnabled,
    toggleSound,
    toggleBgm,
    togglePanel,
    closePanel,
    handleOutsidePointer,
  }
}
