/**
 * 报文解析规则模块
 * --------------------------------------------------------------------
 * 集中存放气象报文解析所需的常量、代码表与工具函数：
 *   - 单位换算（KT -> MPS、云高 英尺 -> 米）
 *   - 现象代码表（描述符 / 降水 / 遮蔽 / 其他）
 *   - 默认识别阈值
 *   - CAVOK 常量
 *   - 跨月日期推断工具 adjustCrossMonth
 *
 * 通过 window.ParsingRules 暴露，被 taf-parser.js 等模块消费。
 * 参考 weather-report-parser skill 整理。
 */
(function (global) {
    'use strict';

    /* ============================================================
     * 单位换算
     * ============================================================ */

    /** 1 节 = 0.514444 m/s */
    var KT_TO_MS = 0.514444;

    /** 1 ft = 0.3048 m；TAF 云高按百英尺取整时使用 30（约 30.48 × 100 / 100） */
    var FT_TO_M = 30.48;
    var CLOUD_FT_TO_M = 30; // 兼容 skill 行为：云高百英尺步进取 ×30

    /**
     * 风速换算：KT 或 MPS → m/s
     * @param {number} value 原值
     * @param {string} unit  'KT' 或 'MPS'
     * @returns {number} 保留 1 位小数的 m/s
     */
    function toMs(value, unit) {
        if (value === null || value === undefined || isNaN(value)) return 0;
        if (unit === 'KT') return Math.round(value * KT_TO_MS * 10) / 10;
        return Math.round(value * 10) / 10; // MPS 直接使用
    }

    /**
     * 云高英尺 → 米
     * @param {number} hundredFt 云高百英尺整数（如 040 表示 4000ft）
     */
    function cloudHeightToMeters(hundredFt) {
        if (hundredFt === null || hundredFt === undefined) return null;
        return hundredFt * CLOUD_FT_TO_M;
    }

    /* ============================================================
     * 现象代码表
     * ============================================================ */

    /** 描述符（位于现象串最前） */
    var DESCRIPTORS = ['TS', 'FZ', 'SH', 'BC', 'DR', 'BL', 'MI'];

    /** 降水 */
    var PRECIPITATION = ['RA', 'DZ', 'SN', 'SG', 'PL', 'GR', 'GS', 'UP'];

    /** 遮蔽 */
    var OBSCURATION = ['BR', 'FG', 'FU', 'VA', 'DU', 'SA', 'SS', 'PY'];

    /** 其他 */
    var OTHER = ['SQ', 'FC', 'DS'];

    /** 已知现象代码全集（用于判定某个 token 是否为天气现象） */
    var ALL_PHENOMENA = [].concat(DESCRIPTORS, PRECIPITATION, OBSCURATION, OTHER);

    /* ============================================================
     * 默认阈值与常量
     * ============================================================ */

    var DEFAULT_RULES = {
        windThreshold: 8,    // 平均风 m/s
        gustThreshold: 8,    // 阵风 m/s
        visThreshold: 2000,  // 能见度 m
        tempThreshold: 10,   // Tmin ℃
        // 沙尘类代码：SA 扬沙 / SS 沙暴 / DS 尘暴 / DU 浮尘
        // 当能见度 ≤ 2000m 且出现这些代码时，"天气现象"列写入对应中文标签
        // （代码前的强度前缀 + / - 在解析阶段已剥离，识别不受影响）
        dustCodes: ['SA', 'SS', 'DS', 'DU']
    };

    /** CAVOK 时能见度视为 10000m */
    var CAVOK_VISIBILITY = 10000;

    /**
     * CAVOK / NSC 判定的云底高阈值（m）
     * --------------------------------------------------------------------
     * ICAO 标准为「1500 m 或机场最低安全高度（MSA）取其大」。
     * 本工具暂以 1500 m 统一值实现，未引入各机场 MSA 表。
     * 后续若接入 MSA 数据源，只需替换此常量，下游解析/翻译自动联动。
     */
    var CAVOK_CLOUD_THRESHOLD_M = 1500;

    /* ============================================================
     * 跨月处理
     * ============================================================ */

    /**
     * 推断 TAF 中的 day/hour 是否位于参考日期的下一个月。
     * 依据：TAF 没有月份信息，TAF 的 day/hour 仅能解释为"参考月"或"下个月"。
     * 若 day 与参考日差距超过 15 天（粗略经验值），倾向于解释为下月。
     *
     * @param {number} day TAF 中的"日"
     * @param {number} hour TAF 中的"时"
     * @param {number} minute TAF 中的"分"（可省略）
     * @param {Date} refDate 参考日期（默认当前时间）
     * @returns {{year:number, month:number, day:number, hour:number, minute:number}}
     */
    function adjustCrossMonth(day, hour, minute, refDate) {
        var ref = refDate || new Date();
        var refDay = ref.getDate();
        var refMonth = ref.getMonth();
        var refYear = ref.getFullYear();

        // 简单策略：若 day 与 refDay 差值 <= 15，按当月；否则下月
        var month = refMonth;
        var year = refYear;
        var diff = day - refDay;
        if (diff < -15) {
            month += 1;
            if (month > 11) { month = 0; year += 1; }
        } else if (diff > 15) {
            // day 比 refDay 大很多，可能在下月（少见但可能）
            // 暂不处理，保持当月
        }
        return { year: year, month: month + 1, day: day, hour: hour || 0, minute: minute || 0 };
    }

    /**
     * 将 TAF 报告中的 day/hour 与参考日期推断为绝对时间戳（毫秒）。
     * 主要用于两份 TAF 的"最新"比较。
     *
     * @param {object} report TAF 报告 {issue:{day,hour,min}, validPeriod:{startDay,...}}
     * @param {Date} refDate
     * @returns {number} 毫秒时间戳
     */
    function tafIssueToTimestamp(report, refDate) {
        var ref = refDate || new Date();
        var adj = adjustCrossMonth(report.issue.day, report.issue.hour, report.issue.min, ref);
        // 若有效时间段起点更晚，用其作为锚点
        if (report.validPeriod && report.validPeriod.startDay) {
            var start = adjustCrossMonth(report.validPeriod.startDay, report.validPeriod.startHour || 0, 0, ref);
            // 关键：若 issue.day 看起来比 startDay 小很多（>= 15），视为下月
            var startMonthDiff = (start.month - adj.month);
            if (startMonthDiff < -1 || startMonthDiff > 1) {
                // 月份跨度异常，按 validPeriod 调整
                adj = { year: start.year, month: start.month,
                    day: adj.day, hour: adj.hour, minute: adj.minute };
            }
        }
        return new Date(adj.year, adj.month - 1, adj.day, adj.hour, adj.minute).getTime();
    }

    /**
     * 比较两份 TAF 的发布时间。
     * 正数表示 a 更新；负数表示 b 更新。
     */
    function compareIssueAdvanced(a, b, refDate) {
        return tafIssueToTimestamp(a, refDate) - tafIssueToTimestamp(b, refDate);
    }

    /* ============================================================
     * CAVOK 判定
     * ============================================================ */

    /**
     * 判断一个 visibility 对象是否为 CAVOK。
     * 约定 visibility.raw === 'CAVOK' 或 visibility.cavok === true。
     */
    function isCavok(visibility) {
        if (!visibility) return false;
        if (visibility.raw === 'CAVOK') return true;
        if (visibility.cavok === true) return true;
        return false;
    }

    /**
     * 判断一个 cloud 对象是否为 NSC。
     * 约定 cloud.type === 'NSC'。
     * 用途：与 SKC / NCD / CLR 区分；NSC 表明"无 1500 m 以下显著云、无 CB/TCU"，
     * 仍可与独立的能见度、天气现象同组出现。
     */
    function isNsc(cloud) {
        if (!cloud) return false;
        return cloud.type === 'NSC';
    }

    /* ============================================================
     * 导出
     * ============================================================ */

    var ParsingRules = {
        // 单位
        KT_TO_MS: KT_TO_MS,
        FT_TO_M: FT_TO_M,
        CLOUD_FT_TO_M: CLOUD_FT_TO_M,
        toMs: toMs,
        cloudHeightToMeters: cloudHeightToMeters,

        // 现象代码表
        DESCRIPTORS: DESCRIPTORS,
        PRECIPITATION: PRECIPITATION,
        OBSCURATION: OBSCURATION,
        OTHER: OTHER,
        ALL_PHENOMENA: ALL_PHENOMENA,

        // 默认阈值
        DEFAULT_RULES: DEFAULT_RULES,
        CAVOK_VISIBILITY: CAVOK_VISIBILITY,
        CAVOK_CLOUD_THRESHOLD_M: CAVOK_CLOUD_THRESHOLD_M,
        isCavok: isCavok,
        isNsc: isNsc,

        // 跨月处理
        adjustCrossMonth: adjustCrossMonth,
        tafIssueToTimestamp: tafIssueToTimestamp,
        compareIssueAdvanced: compareIssueAdvanced
    };

    global.ParsingRules = ParsingRules;
})(window);
