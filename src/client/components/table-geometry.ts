/**
 * 牌桌几何的唯一来源。
 *
 * 座位锚点、中央安全区宽度、公共牌尺寸与舞台留白都集中在这里，
 * CSS 只通过 `--seat-gap` / `--stage-pad-*` 这类变量消费，不再各自写死数值。
 *
 * 改动顺序建议：
 *   1. 调这里的档位常量；
 *   2. 跑 `npm run probe:table` 看重叠像素；
 *   3. 跑 `npx playwright test tests/e2e/poker-room.spec.ts -g 几何`。
 */

/** 座位椭圆横向/纵向半径（相对桌面宽高的百分比）。 */
export interface SeatAnchor {
  /** 横向半径百分比（43 表示「离桌心 43% 桌宽」）。 */
  x: number
  /** 纵向半径百分比。 */
  y: number
}

/** 桌面几何档位：按视口归类，后写的档位覆盖先写的。 */
export interface TableGeometryTier {
  /** 档位名，只用于注释与调试。 */
  name: string
  /** 命中该档位的媒体查询（空字符串 = 基础档）。 */
  query: string
  /** 桌面宽 / 高（CSS 值）。 */
  width: string
  height: string
  /** 座位椭圆半径。 */
  anchor: SeatAnchor
  /** 座位面板宽度。 */
  seatWidth: string
  /** 贴边座位面板宽度（左右两列更窄）。 */
  sideSeatWidth: string
  /** 座位面板纵向内边距。 */
  seatPaddingBlock: string
  /** 中央列左右各需要的净宽（座位 + 徽章 + 呼吸），用于 `max-width` 计算。 */
  centerInset: number
  /** 公共牌宽度（五张 + 牌距要装进中央列）。 */
  boardCardWidth: string
  /** 中央列纵向位置。 */
  centerTop: string
  /**
   * 中央列纵向安全边距（px）：中央列最多占到「桌面高度 - 2×inset」，
   * 给上下两排座位留出净空。桌面变矮时比单纯调 centerTop 更可靠。
   */
  centerMaxHeightInset: number
  /**
   * 牌桌整体下移量（px，只影响视觉位置，不改变座位百分比定位）。
   * 摊牌亮牌后座位卡片会向上长高，下移一点可以给「卡片上方的下注徽章 / 赢家徽章」
   * 让出顶部 HUD 的净空；桌面档与紧凑档保持 0。
   */
  shiftY: number
  /**
   * 接近水平的中左/中右座位（|sin| ≤ 0.55）额外向下偏移量（px）。
   * 这类座位卡片正好在上一张卡片正下方，信息贴得太近；竖屏给 8px，桌面档 0。
   * 只加在 top 上，左右两侧 sin 相同 → 偏移相同，镜像对称不变。
   */
  sideSeatShiftY: number
}

/** 桌面级变量：所有档位共享的材质与结构尺寸。 */
export interface TableBaseGeometry {
  /** 皮革包边宽度（桌面外圈）。 */
  railWidth: number
  /** 舞台留白：上下左右。 */
  stagePadding: { top: number; right: number; bottom: number; left: number }
  /** 桌面最大高度（竖屏档防止平板把桌子拉太高）。 */
  maxHeight: number
}

/**
 * 竖屏牌桌档位表。
 *
 * 这些数字都有实测依据（见各条注释），不要为了「看起来整齐」随手改。
 */
export const TABLE_GEOMETRY: readonly TableGeometryTier[] = [
  {
    /*
     * 竖屏基准档（390×844 等）。
     *
     * 2026-10 第三轮：操作区（task-6）从 271px 压到 211.4px 后，舞台从 503.8 增高到 563.6，
     * 多出的高度全部给牌桌：306×334 → 312×380（宽高都放大，仍保持「座位锚点 50%/50%、
     * 面板中心落在桌沿、一半探出桌外」的观感）。
     *
     * 高度写 `min(380px, calc(100% - 85px))`：390×844 时舞台内容 487.6px，
     * 100% - 85px = 402.6 > 380，取 380（留给顶部 HUD 23px、底部座舱 63px 余量）；
     * 矮屏（如 375×667）会自动缩到 `内容高度 - 85px`，保证顶部 81px 高的摊牌面板
     * 不会压住 HUD 胶囊（HUD 底边 y=107，面板半高 40.5，再留 12px 呼吸 ≈ 85px）。
     *
     * 宽度 `min(100vw - 78px, 312px)`：390 宽时 312（验收范围 306–316），
     * 左右两列座位（74.1px 宽）外沿仍在视口内（实测 fullRing minX=4.4 / maxX=385.6）。
     */
    name: 'portrait-base',
    query: '(max-width: 560px) and (orientation: portrait)',
    width: 'min(calc(100vw - 78px), 312px)',
    height: 'min(380px, calc(100% - 88px))',
    /* 50/50 = 面板中心落在桌面椭圆外沿（见上方说明）。 */
    anchor: { x: 50, y: 50 },
    /*
     * 座位卡改「窄 3 行」（task-12）：390 普通 66.3px / 侧边 58.5px。
     * 第 1 行座位号+昵称、第 2 行 D/SB/BB/状态标、第 3 行筹码；面板内边距与字号在
     * PlayerSeat 的竖屏规则里同步收小，4 位筹码与现有昵称都不截断。
     */
    seatWidth: 'clamp(62px, 17vw, 68px)',
    sideSeatWidth: 'clamp(54px, 15vw, 60px)',
    seatPaddingBlock: '4px',
    /* 中央列净宽（实际由 CSS 的 --seat-w-side 计算，这里只作记录）。 */
    centerInset: 120,
    /*
     * 公共牌：座位不再占公共牌行两侧，390 宽放大到 36px（32 → 36，验收 36–38）。
     * 5×36 + 牌距 ≈ 208px，完全落在 312px 桌面内；与侧边座位横向仍留 ≥3px 净空。
     */
    boardCardWidth: 'clamp(34px, 9.3vw, 36px)',
    centerTop: '45%',
    /*
     * 座位锚点外移到 50% 后，上下两排面板本身就让开了中央列，
     * 不再需要大额纵向安全边距（只留 52px 防止面板圆角贴到中央块）。
     */
    centerMaxHeightInset: 52,
    /*
     * 牌桌整体下移 12px（task-12）：亮牌时卡片向上长高（2 张 30px 的牌 ≈43px），
     * 顶部座位的下注徽章/赢家徽章会向 HUD 靠近；下移 12px 后仍保留 ≥10px 净空。
     * 与高度公式的 88px 预留配合：更矮的屏幕会自动缩桌，绝不压 HUD。
     */
    shiftY: 12,
    /* 中左/中右座位下移 8px，避免信息与上方卡片贴在一起。 */
    sideSeatShiftY: 8,
  },
  {
    /*
     * 360×740 这类矮机：舞台内容 383.6px，比基准档少约 104px。
     * 牌桌从 296×252 放大到 300×292（验收范围 296–306 × 270–295），
     * 顶部 81px 的摊牌面板距 HUD（y=107）仍有 ~15px；本人面板距座舱顶边 ~55px。
     * `calc(100% - 85px)` 兜底：更矮的屏幕自动缩桌子，绝不压 HUD。
     */
    name: 'portrait-short',
    query: '(max-width: 560px) and (orientation: portrait) and (max-height: 780px)',
    width: 'min(calc(100vw - 60px), 300px)',
    height: 'min(292px, calc(100% - 88px))',
    anchor: { x: 50, y: 50 },
    /* 360 档再小一档：普通 59.4px / 侧边 52.2px，仍能完整显示 4 位筹码。 */
    seatWidth: 'clamp(56px, 16.5vw, 62px)',
    sideSeatWidth: 'clamp(50px, 14.5vw, 56px)',
    seatPaddingBlock: '3px',
    centerInset: 108,
    /* 360 宽公共牌 32px（26 → 32，验收 30–32）：5×32 + 牌距 ≈ 188px，桌面 300px。 */
    /* 320 宽这类窄机：下限收到 28px，中央列才不会碰到 330°/210° 的上侧座位。 */
    boardCardWidth: 'clamp(28px, 8.9vw, 32px)',
    centerTop: '45%',
    centerMaxHeightInset: 40,
    /* 同基准档：下移 12px，给亮牌后的顶部徽章留 HUD 净空。 */
    shiftY: 12,
    sideSeatShiftY: 8,
  },
  {
    // 超短屏：9 人环放不下，切「紧凑牌桌」两列布局（见 compactSeatStyle）。
    name: 'compact',
    query: '(max-width: 360px) and (max-height: 620px)',
    width: 'calc(100vw - 16px)',
    height: '100%',
    anchor: { x: 43, y: 22 },
    seatWidth: '62px',
    sideSeatWidth: '62px',
    seatPaddingBlock: '1px',
    centerInset: 170,
    boardCardWidth: 'clamp(20px, calc((100vw - 200px) / 5), 28px)',
    // 紧凑档桌面极矮（~125px），本人座位贴在桌下沿中央：
    // 中央列上移到 36%，把底下那点净空留给本人座位。
    centerTop: '36%',
    // 紧凑档是「两列座位夹中央列」的布局，中央列本来就避开座位，不再加纵向约束
    // （桌面只有 ~107px，再加 34px 边距会把底池与公共牌压到放不下）。
    centerMaxHeightInset: 0,
    // 紧凑档桌面几乎撑满舞台，下移会压到底部操作区，保持 0。
    shiftY: 0,
    sideSeatShiftY: 0,
  },
]

/** 基础（桌面 / 横屏）几何。 */
export const TABLE_BASE: TableBaseGeometry = {
  railWidth: 16,
  stagePadding: { top: 4, right: 16, bottom: 0, left: 16 },
  maxHeight: 460,
}

/** 竖屏舞台留白：上方给 HUD 浮动胶囊让位，下方给本人座位与英雄手牌区留呼吸空间。 */
/*
 * 竖屏舞台留白。
 * 顶部 50px 给 HUD 浮动胶囊；底部 38px 原来留给「本人座位 + 英雄手牌」的呼吸空间，
 * 现在操作区的离座/退出已改到座舱右上角、不再占一行，底部可以再收 10px 给牌桌。
 */
export const STAGE_PADDING_PORTRAIT = { top: 48, right: 8, bottom: 28, left: 8 }
/** 超短屏舞台留白：把纵向空间让给牌桌。 */
export const STAGE_PADDING_COMPACT = { top: 30, right: 6, bottom: 24, left: 6 }
/** 低于这个高度用紧凑舞台留白。 */
export const COMPACT_STAGE_MAX_HEIGHT = 600

/**
 * 生成牌桌几何 CSS（基础变量 + 每个档位的媒体查询覆盖）。
 *
 * 注：媒体查询里的自定义属性**不能**写到 `:root` 上——
 * `:root` 上的声明只会按「元素自身」的视口条件求值一次并全局继承，
 * 媒体查询切换时不会重新解析。必须落到实际使用它的元素上（`.table` / `.stage`），
 * 这里用 `var()` 的继承链把档位值分别挂到这两个选择器上。
 */
export function buildTableGeometryCss(): string {
  const base = `
:root {
  --rail-width: ${String(TABLE_BASE.railWidth)}px;
  --stage-pad-top: ${String(TABLE_BASE.stagePadding.top)}px;
  --stage-pad-right: ${String(TABLE_BASE.stagePadding.right)}px;
  --stage-pad-bottom: ${String(TABLE_BASE.stagePadding.bottom)}px;
  --stage-pad-left: ${String(TABLE_BASE.stagePadding.left)}px;
  --table-max-height: 100%;
}
`
  const tiers = TABLE_GEOMETRY.map((tier) => {
    const padding = tier.name === 'compact' ? STAGE_PADDING_COMPACT : STAGE_PADDING_PORTRAIT
    return `
@media ${tier.query} {
  .stage {
    --stage-pad-top: ${String(padding.top)}px;
    --stage-pad-right: ${String(padding.right)}px;
    --stage-pad-bottom: ${String(padding.bottom)}px;
    --stage-pad-left: ${String(padding.left)}px;
  }
  .table {
    --table-width: ${tier.width};
    --table-height: ${tier.height};
    --table-max-height: ${String(TABLE_BASE.maxHeight)}px;
    --seat-anchor-x: ${String(tier.anchor.x)}%;
    --seat-anchor-y: ${String(tier.anchor.y)}%;
    --seat-w: ${tier.seatWidth};
    --seat-w-side: ${tier.sideSeatWidth};
    --seat-padding-block: ${tier.seatPaddingBlock};
    --center-inset: ${String(tier.centerInset)}px;
    --board-cw: ${tier.boardCardWidth};
    --center-top: ${tier.centerTop};
    --center-max-height-inset: ${String(tier.centerMaxHeightInset)}px;
    --table-shift-y: ${String(tier.shiftY)}px;
    --seat-side-shift-y: ${String(tier.sideSeatShiftY)}px;
  }
}
`
  })

  return base + tiers.join('')
}
