/**
 * 气象预警记录表 EXCEL 导出
 * --------------------------------------------------------------------
 * 设计目标
 *   1. 从用户填写的预警内容（data.forecast）中自动解析「发生时段」
 *      - 显式时间段 X-Y（如 14:20-15:00）
 *      - 跨天时段（如 17:00-次日10:00）：结束时间保留「次日」标记，支持次日/第二天/翌日写法
 *      - X 前 关键词（如 17:00前）
 *      - X 后 关键词（如 15:00后）
 *      - 多时段合并：第一个开始 - 最后一个结束
 *      - 兜底：发布时间 HH:MM
 *   2. 自动计算「预报时长」：结束HH:MM - 开始HH:MM，跨日 +24h
 *      表格列标题为「预报时长(h)」承担单位语义，单元格内只填纯数字（如 5.3、3）
 *   3. 输出 11 列 EXCEL：序号/日期/影响机场/预警等级/天气类型/预警内容/发布时间/发生时段/预报时长(h)/制作人/发布序号
 *   4. 样式与参考模板一致：表头加粗 11pt、黑色实线边框、水平+垂直居中、行高自适应
 *   5. 文件名：气象预警记录表_YYYYMMDD.xlsx（北京时日期）
 *   6. 当日已导出的记录通过 chrome.storage.local 持久化（键 met_tool_warning_record_log）
 *      每次导出时合并当日所有记录 → 生成完整文件 → 触发下载
 *      这样即使多次下载，文件内始终包含当日全部记录
 *   7. 解析前对预警内容与发布时间执行标点规范化（全角→半角）和时间格式规范化
 *      （1500 / 15时 / 15时30分 / 15：00 / 14-15时 → 15:00），兼容 Word 复制粘贴与多种用户输入写法
 *      这些规范化只发生在解析入口，不影响发生时段 / 预报时长 的计算结果
 *
 * 11 列结构说明（v2.1 列序精化后）：
 *   A 序号        纯行号计数器（1, 2, 3, ...），按文件内行序自增
 *   B 日期        yyyy-MM-dd
 *   C 影响机场    机场名称
 *   D 预警等级    红色/橙色/黄色
 *   E 天气类型    雷雨/小阵雨/...
 *   F 预警内容    原文
 *   G 发布时间    HH:MM
 *   H 发生时段    解析结果（如 14:30-15:30）
 *   I 预报时长(h) 纯数字（不带 h 后缀；列标题承担单位语义）
 *   J 制作人      制作人姓名
 *   K 发布序号    data.serialNo（如 20260718001），业务编号，便于溯源原文
 *
 * 暴露对象：window.WarningRecordExporter
 *   - parsePeriod(forecast, publishHHMM): 解析发生时段
 *   - computeDuration(period): 计算预报时长
 *   - extractPublishDate(publishTime): 提取 yyyy-MM-dd 日期
 *   - extractPublishHHMM(publishTime): 提取 HH:MM 时间
 *   - normalizePunctuation(text): 全角标点→半角标点
 *   - exportRecord(data, options): 触发下载
 *   - getLog(dateKey): 读取当日记录（调试用）
 *   - clearLog(dateKey): 清除当日记录（调试用）
 */
(function (global) {
    'use strict';

    /* ============================================================
     * 常量
     * ============================================================ */

    /** chrome.storage.local 存储键：按北京时日期分组的预警记录 */
    var STORAGE_KEY = 'met_tool_warning_record_log';
    /**
     * 表头（共 11 列，v2.1 列序精化后）
     *   A 序号        纯行号计数器（按文件内行序自增 1, 2, 3, ...）
     *   B 日期        yyyy-MM-dd
     *   C 影响机场
     *   D 预警等级
     *   E 天气类型
     *   F 预警内容
     *   G 发布时间    HH:MM
     *   H 发生时段
     *   I 预报时长(h)
     *   J 制作人
     *   K 发布序号    data.serialNo（业务编号，如 20260718001），原 B 列「序号」改名并移至末尾
     */
    var HEADERS = [
        '序号',          // A 纯计数器
        '日期',          // B
        '影响机场',      // C
        '预警等级',      // D
        '天气类型',      // E
        '预警内容',      // F
        '发布时间',      // G
        '发生时段',      // H
        '预报时长(h)',   // I
        '制作人',        // J
        '发布序号'       // K（原「序号」改名移至末尾）
    ];
    /** 文件名前缀 */
    var FILENAME_PREFIX = '气象预警记录表';

    /**
     * 跨天标记词：结束时间落在次日时用户可能书写的写法（次日 / 第二天 / 翌日）
     * 例：17:00-次日10:00、05:00到第二天02:00
     */
    var NEXT_DAY_MARKER = '(?:次日|第二天|翌日)';

    /** 跨天标记的规范输出文本（解析结果统一按「次日」输出，与气象简报截图跨天写法一致） */
    var NEXT_DAY_TEXT = '次日';

    /* ============================================================
     * 时间解析
     * ============================================================ */

    /**
     * 解析 HH:MM 字符串为分钟数（自零点起）
     * 特殊处理：24:00 视为当日结束（= 1440 分钟，即次日 00:00）
     * @param {string} hhmm 形如 "14:20"、"9:05"、"24:00"
     * @returns {number|null} 分钟数；非法输入返回 null
     */
    function parseHHMMToMinutes(hhmm) {
        if (!hhmm || typeof hhmm !== 'string') return null;
        var m = String(hhmm).match(/^(\d{1,2}):(\d{2})$/);
        if (!m) return null;
        var h = parseInt(m[1], 10);
        var min = parseInt(m[2], 10);
        if (isNaN(h) || isNaN(min) || h < 0 || min < 0 || min > 59) return null;
        // 24:00 视为 1440 分钟（当日结束）；> 24 视为非法
        if (h > 24) return null;
        if (h === 24 && min !== 0) return null;  // 24:01 ~ 24:59 非法
        return h * 60 + min;
    }

    /** 分钟数 → HH:MM */
    function minutesToHHMM(mins) {
        if (mins == null || isNaN(mins)) return '';
        var h = Math.floor(mins / 60);
        var m = mins % 60;
        return pad2(h) + ':' + pad2(m);
    }

    function pad2(n) { return n < 10 ? '0' + n : '' + n; }

    /**
     * 从预警内容中提取所有「显式时间段 X-Y」和「X 前」「X 后」关键词
     * 优先顺序：
     *   1) 显式时间段 X-Y（含 — ~ 到 至 等分隔符）
     *   2) X 前 关键词（作为结束时间）
     *   3) X 后 关键词（仅作为开始时间的参考；不形成完整时段）
     * @param {string} forecast 预警内容文本
     * @returns {{
     *   explicitRanges: Array<{start:string,end:string,endNextDay:boolean}>,
     *   beforeTimes: string[],
     *   afterTimes: string[]
     * }}
     */
    function extractTimePatterns(forecast) {
        var result = { explicitRanges: [], beforeTimes: [], afterTimes: [] };
        if (!forecast || typeof forecast !== 'string') return result;

        // 入口规范化（按顺序执行，后一步基于前一步结果）：
        //   1) 标点规范化：全角标点 → 半角标点
        //      解决 Word 复制粘贴场景中 `14：20-15：00`、`14:00-15:00、15:00-16:00` 等无法解析的问题
        //   2) 时间格式规范化：`1500` / `15时` / `15时30分` → `15:00` / `15:30`
        //      保证下游 rangeRe / beforeRe / afterRe 只看到统一的 HH:MM 写法
        var normalized = normalizePunctuation(forecast);
        normalized = normalizeTimeFormats(normalized);

        // 1. 显式时间段 X-Y（X 和 Y 都是 HH:MM，分隔符: - — ~ 到 至）
        //    结束时间可带跨天标记（次日 / 第二天 / 翌日），用于跨零点时段
        // 例: 14:20-15:00 / 21:00 - 24:00 / 14:20到15:00 / 17:00-次日10:00
        var rangeRe = new RegExp(
            '(\\d{1,2}:\\d{2})\\s*[-—~到至]\\s*(' + NEXT_DAY_MARKER + ')?\\s*(\\d{1,2}:\\d{2})',
            'g'
        );
        var match;
        while ((match = rangeRe.exec(normalized)) !== null) {
            result.explicitRanges.push({
                start: match[1],
                end: match[3],
                // 结束时间是否标注跨天（次日 / 第二天 / 翌日）
                endNextDay: !!match[2]
            });
        }

        // 2. X 前 关键词（X 是 HH:MM，且后面没有数字，避免误匹配「前 2 小时」之类）
        //    用 (?!\s*\d) 排除「前 2」「前 30 分钟」这种用法
        var beforeRe = /(\d{1,2}:\d{2})\s*前(?!\s*\d)/g;
        while ((match = beforeRe.exec(normalized)) !== null) {
            result.beforeTimes.push(match[1]);
        }

        // 3. X 后 关键词
        var afterRe = /(\d{1,2}:\d{2})\s*后/g;
        while ((match = afterRe.exec(normalized)) !== null) {
            result.afterTimes.push(match[1]);
        }

        return result;
    }

    /**
     * 拼接单个时段的展示文本
     * @description 跨天时段（结束时间标注次日）输出为「开始-次日结束」，
     *              与气象简报机场预警截图的跨天写法保持一致，便于人工核对
     * @param {{start: string, end: string, endNextDay?: boolean}} range 时间范围
     * @returns {string} 形如 "14:20-15:00" 或 "17:00-次日10:00"
     */
    function formatRangeText(range) {
        return range.start + '-' + (range.endNextDay ? NEXT_DAY_TEXT : '') + range.end;
    }

    /**
     * 解析「发生时段」
     * 规则：
     *   1. 有 ≥1 个显式时间段 → 多段合并（第一个开始 - 最后一个结束）；单段直接用
     *      结束时间带跨天标记时保留标记，输出「开始-次日结束」（如 17:00-次日10:00）
     *   2. 无显式时间段但有 X 前 → 发布时间HH:MM - X
     *   3. 无显式时间段但有 X 后 → 发布时间HH:MM - X (X 是参考结束时间)
     *      说明：X 后 表示 X 是开始，但若无 X 前，则退化为「发布时间 - X」
     *   4. 都无 → 空字符串
     * @param {string} forecast 预警内容
     * @param {string} publishHHMM 发布时间 HH:MM（形如 "11:45"）
     * @returns {string} 发生时段，形如 "14:20-15:00"；跨天为 "17:00-次日10:00"；无法解析返回 ''
     */
    function parsePeriod(forecast, publishHHMM) {
        var patterns = extractTimePatterns(forecast);
        var pubMin = parseHHMMToMinutes(publishHHMM);

        // 规则 1: 显式时间段（可能有多个）
        if (patterns.explicitRanges.length > 0) {
            var ranges = patterns.explicitRanges;
            // 过滤掉开始/结束无效的段
            var validRanges = ranges.filter(function (r) {
                return parseHHMMToMinutes(r.start) != null && parseHHMMToMinutes(r.end) != null;
            });
            if (validRanges.length === 0) {
                // 显式段全无效，尝试 X 前
            } else if (validRanges.length === 1) {
                return formatRangeText(validRanges[0]);
            } else {
                // 多段：第一个开始 - 最后一个结束（跨天标记沿用最后一段的结束）
                var lastRange = validRanges[validRanges.length - 1];
                return formatRangeText({
                    start: validRanges[0].start,
                    end: lastRange.end,
                    endNextDay: lastRange.endNextDay
                });
            }
        }

        // 规则 2: X 前 关键词（无显式段时生效）
        if (patterns.beforeTimes.length > 0) {
            // 多个 X 前：取最后一个（通常是最近期的截止时间）
            var beforeEnd = patterns.beforeTimes[patterns.beforeTimes.length - 1];
            // 开始时间：发布时间（HH:MM）
            var startByPub = publishHHMM || patterns.afterTimes[0] || '';
            if (startByPub && parseHHMMToMinutes(startByPub) != null) {
                return startByPub + '-' + beforeEnd;
            }
        }

        // 规则 3: X 后 关键词（无显式段、无 X 前时生效）
        // X 后 的 X 是开始时间；如果发布时间可解析，作为「开始 - X」（退化为短时段）
        if (patterns.afterTimes.length > 0) {
            // 这里采用保守策略：仅在有发布时间时输出「发布时间-X」，提示用户注意
            if (pubMin != null && publishHHMM) {
                return publishHHMM + '-' + patterns.afterTimes[0];
            }
        }

        // 规则 4: 无法解析
        return '';
    }

    /* ============================================================
     * 时长计算
     * ============================================================ */

    /**
     * 计算预报时长（小时）
     * @param {string} period 发生时段，形如 "14:20-15:00"；跨天形如 "17:00-次日10:00"
     * @returns {number|null} 小时数；非法输入返回 null
     */
    function computeDurationHours(period) {
        if (!period || typeof period !== 'string') return null;
        // 结束时间允许带跨天标记「次日」（parsePeriod 的跨天输出）
        var m = String(period).match(/^(\d{1,2}:\d{2})\s*-\s*(次日)?\s*(\d{1,2}:\d{2})$/);
        if (!m) return null;
        var startMin = parseHHMMToMinutes(m[1]);
        var endMin = parseHHMMToMinutes(m[3]);
        if (startMin == null || endMin == null) return null;
        // 跨日：显式标注「次日」，或结束 ≤ 开始时（隐含跨零点），均 +24h（即 1440 分钟）
        if (m[2] || endMin <= startMin) {
            endMin += 24 * 60;
        }
        return (endMin - startMin) / 60;
    }

    /**
     * 把小时数格式化为字符串（不再追加单位 "h"）
     * - 规则：四舍五入到 0.1h，去掉末尾的 ".0"
     * - 输出形如 "5.3"、"0.5"、"3"；非法输入返回 ''
     * - 表格中由列标题"预报时长(h)"承担单位语义，单元格内不再重复 h
     * @param {number} h
     * @returns {string}
     */
    function formatHours(h) {
        if (h == null || isNaN(h)) return '';
        // 四舍五入到 0.1h
        var rounded = Math.round(h * 10) / 10;
        // 去掉末尾的 .0
        var str = rounded.toFixed(1);
        if (str.endsWith('.0')) str = str.slice(0, -2);
        return str;
    }

    /**
     * 计算并格式化预报时长
     * @param {string} period 发生时段
     * @returns {string} 形如 "5.3"、"0.5"、"3"；无法计算返回 ''
     */
    function computeDuration(period) {
        var hours = computeDurationHours(period);
        if (hours == null) return '';
        return formatHours(hours);
    }

    /* ============================================================
     * 时间戳与文件名
     * ============================================================ */

    /**
     * 获取北京时（UTC+8）相关格式化
     * @param {Date} [d]
     * @returns {{dateStamp: string, hhmm: string, ymd: string, timeHHmmss: string}}
     */
    function getBeijingParts(d) {
        if (!d) d = new Date();
        var utc = d.getTime() + d.getTimezoneOffset() * 60 * 1000;
        var bj = new Date(utc + 8 * 60 * 60 * 1000);
        return {
            dateStamp: bj.getFullYear() + pad2(bj.getMonth() + 1) + pad2(bj.getDate()),
            hhmm: pad2(bj.getHours()) + ':' + pad2(bj.getMinutes()),
            ymd: bj.getFullYear() + '年' + (bj.getMonth() + 1) + '月' + bj.getDate() + '日',
            timeHHmmss: pad2(bj.getHours()) + pad2(bj.getMinutes()) + pad2(bj.getSeconds())
        };
    }

    /**
     * 生成 Excel 文件名
     * @param {string} dateStamp yyyyMMdd 格式
     * @param {string} [timeHHmmss] hhmmss 格式；提供时拼接到文件名后避免覆盖
     * @returns {string} 文件名
     */
    function getRecordFilename(dateStamp, timeHHmmss) {
        if (timeHHmmss) {
            return FILENAME_PREFIX + '_' + dateStamp + '_' + timeHHmmss + '.xlsx';
        }
        return FILENAME_PREFIX + '_' + dateStamp + '.xlsx';
    }

    /* ============================================================
     * 数据规范化
     * ============================================================ */

    /**
     * 标点规范化：将全角标点替换为半角标点，兼容 Word 复制粘贴场景
     * 映射表：
     *   - `：` (U+FF1A) → `:`
     *   - `；` (U+FF1B) → `;`
     *   - `，` (U+FF0C) → `,`
     *   - `、` (U+3001) → `,`
     *   - `　` (U+3000) → ` `（全角空格 → 半角空格）
     *   - `－` (U+FF0D) → `-`（全角连接符）
     *   - `—` (U+2014) → `-`（破折号）
     *   - `——` (U+2014 × 2) → `-`（双破折号，视为单连字符）
     * 幂等性：标准输入再走一遍结果不变。
     * @param {string} text 待规范化文本
     * @returns {string} 规范化后文本；非字符串输入按原值返回
     */
    function normalizePunctuation(text) {
        if (text == null) return text;
        if (typeof text !== 'string') return text;

        // 1) 先处理双破折号 `——` → `-`（必须在单字符替换之前完成，否则会被切碎）
        //    全局替换所有非重叠的 `——`
        var result = text.replace(/——/g, '-');

        // 2) 单字符映射（按出现频次从高到低排列便于阅读，无功能差异）
        result = result
            .replace(/：/g, ':')   // 全角冒号 → 半角冒号
            .replace(/；/g, ';')   // 全角分号 → 半角分号
            .replace(/，/g, ',')   // 全角逗号 → 半角逗号
            .replace(/、/g, ',')   // 顿号 → 半角逗号
            .replace(/　/g, ' ')   // 全角空格 → 半角空格
            .replace(/－/g, '-')   // 全角连接符 → 半角连字符
            .replace(/—/g, '-');  // 破折号 → 半角连字符

        return result;
    }

    /**
     * 时间格式规范化：将预警内容中多种时间写法统一为标准的 HH:MM（半角冒号）格式
     * 兼容以下写法（均会被识别为 15:00）：
     *   - `15:00`（半角冒号；已由现有正则支持，此函数作为幂等保底）
     *   - `15：00`（全角冒号；由 normalizePunctuation 已转为半角，本函数无需处理）
     *   - `15时` → `15:00`（中文时，无分钟）
     *   - `15时30分` / `15时30` → `15:30`（中文时 + 分钟，分钟为可选）
     *   - `1500`（4 位连续数字，无分隔符）
     *   - `14-15时` / `14至15时` / `14到15时` / `14~15时` / `14—15时` → `14:00-15:00`
     *     （整型小时范围 + 时 字；分号可省略）
     *   - `14-15时30分` → `14:00-15:30`（整型小时范围 + 时 + 分钟）
     *
     * 安全约束（避免误伤航班号、年份、HH:MM单位词等场景）：
     *   - N1-N2时 → N1:00-N2:MM 要求 N1 前是字符串开头 / 非冒号 / 非数字；
     *     防止 "24:00-15时" 中误匹配 "00-15时"（:00 前的数字已是 HH:MM 的一部分）
     *   - HH时 → HH:MM 要求：前边界是字符串开头 / 非冒号且非数字的字符（允许中文汉字 / 空白 / 标点 / `-`）
     *     防止 `24:00时` 中的 `00时` 被误识别（`:00` 之前是冒号，视为 `HH:MM` 的单位词，不当作时间标记）
     *   - HHMM → HH:MM 要求：前边界是字符串开头 或 非英文字母且非数字的字符（允许中文汉字 / 空白 / 标点）
     *   - HHMM → HH:MM 要求：后边界是字符串结尾 或 非英文字母且非数字且非 `年月日` 的字符
     *   - 4 位数字若紧跟 `年` / `月` / `日`（日期标识符），视为年份 / 月日，不转换
     *   - 4 位数字若紧跟英文字母（如航班号 `CA1501`），视为代码，不转换
     *   - 小时 00-23、分钟 00-59；24:00 视为合法（与 parseHHMMToMinutes 保持一致）
     *   - 额外收尾：HH:MM时 → HH:MM（移除 `24:00时前` 中 `时` 字作为单位词的歧义）
     *
     * 步骤顺序（关键）：N1-N2时[MM分] 必须先于 HH时[MM分] 执行，
     *   否则 HH时[MM分] 会先吃掉 "15时" 留下 "14-15:00"，导致下游 rangeRe 无法识别
     *
     * 幂等性：重复执行结果不变（已规范的 HH:MM 不会被再次处理）。
     * @param {string} text 待规范化文本
     * @returns {string} 规范化后文本；非字符串输入按原值返回
     */
    function normalizeTimeFormats(text) {
        if (text == null) return text;
        if (typeof text !== 'string') return text;

        var result = text;

        // 0) N1[-—~到至]N2时[MM分] → N1:00-N2:MM
        //    整型小时范围 + 时 字（含可选分钟）
        //    例: "14-15时" → "14:00-15:00"；"14至15时" → "14:00-15:00"；
        //         "8-10时" → "08:00-10:00"；"9-17时" → "09:00-17:00"；
        //         "14-15时30分" → "14:00-15:30"；"14-15时30" → "14:00-15:30"
        //    必须在 step 1（HH时[MM分]）之前执行：
        //      否则 step 1 会先把 "15时" 变成 "15:00"，留下 "14-15:00" 这种残段，
        //      而下游 rangeRe 只能匹配完整的 HH:MM-HH:MM，无法识别整型前缀的混合写法
        //    安全约束：
        //      - N1 前边界：字符串开头 / 非冒号 / 非数字（防止 "24:00-15时" 中误匹配 "00-15时"）
        //      - 时 边界：后不能跟分号/数字（否则会与 step 1 的 "15时30分" 重复匹配）
        //      - 验证：N1, N2 ∈ [0, 24]；N2=24 时 MM 必须为 00
        result = result.replace(
            /(^|[^:\d])(\d{1,2})\s*[-—~到至]\s*(\d{1,2})时(?:(\d{1,2})分?)?/g,
            function (m, pre, sh, eh, mm) {
                var shInt = parseInt(sh, 10);
                var ehInt = parseInt(eh, 10);
                if (isNaN(shInt) || isNaN(ehInt)) return m;
                if (shInt < 0 || shInt > 24 || ehInt < 0 || ehInt > 24) return m;
                var mmStr = '00';
                if (mm != null) {
                    var mmInt = parseInt(mm, 10);
                    if (isNaN(mmInt) || mmInt < 0 || mmInt > 59) return m;
                    if (ehInt === 24 && mmInt !== 0) return m;
                    mmStr = pad2(mmInt);
                }
                return pre + pad2(shInt) + ':00-' + pad2(ehInt) + ':' + mmStr;
            }
        );

        // 1) HH时[MM分] → HH:MM
        //    匹配 1-2 位数字 + 时 + 可选的（1-2 位数字 + 分 或 单独的 1-2 位数字）
        //    例: "15时" → "15:00"；"15时30分" → "15:30"；"15时30" → "15:30"
        //    24:00 视为合法（HH=24, MM=00），与 parseHHMMToMinutes 保持一致
        //    关键：要求"时"前是字符串开头 / 非冒号 / 非数字；防止 "24:00时" 中的 "00时" 被误识别
        //          （冒号前的数字已是 HH:MM 的一部分，"时"是单位词，不是时间标记）
        result = result.replace(/(^|[^:\d])(\d{1,2})时(?:(\d{1,2})分?)?/g, function (m, pre, h, mPart) {
            var hInt = parseInt(h, 10);
            if (isNaN(hInt) || hInt < 0 || hInt > 24) return m;
            if (mPart != null) {
                var mInt = parseInt(mPart, 10);
                if (isNaN(mInt) || mInt < 0 || mInt > 59) return m;
                if (hInt === 24 && mInt !== 0) return m;
                return pre + pad2(hInt) + ':' + pad2(mInt);
            }
            if (hInt === 24) return pre + '24:00';
            return pre + pad2(hInt) + ':00';
        });

        // 2) HHMM → HH:MM（4 位连续数字）
        //    前边界：字符串开头 或 非英文字母且非数字的字符（含中文汉字 / 空白 / 中文标点 / `-` 等）
        //    后边界：字符串结尾 或 非英文字母且非数字且非 `年月日` 的字符（避免误伤日期 / 航班号）
        //    验证：HH ∈ [00, 24] 且 MM ∈ [00, 59]；HH=24 时 MM 必须为 00
        //    替换内容包含原 boundary 字符，保证文本长度可控、不丢上下文
        result = result.replace(
            /(^|[^\dA-Za-z])(\d{2})(\d{2})(?=$|[^\dA-Za-z年月日])/g,
            function (m, pre, hh, mm) {
                var hInt = parseInt(hh, 10);
                var mInt = parseInt(mm, 10);
                if (isNaN(hInt) || isNaN(mInt)) return m;
                if (hInt < 0 || hInt > 24) return m;
                if (mInt < 0 || mInt > 59) return m;
                if (hInt === 24 && mInt !== 0) return m;
                return pre + hh + ':' + mm;
            }
        );

        // 3) HH:MM时 → HH:MM（移除"时"作为单位词）
        //    解决 "24:00时前" / "15:00时后" 等场景：原文本里的"时"只是单位词，
        //    既有 parser 的 beforeRe / afterRe 只能匹配 `HH:MM\s*前` 模式，
        //    中间夹一个"时"字会被漏掉。规范化时统一移除"时"，让 parser 正确识别。
        //    仅在"时"后紧跟 时间相关边界（字符串结尾 / 空白 / 标点 / `-` / 前 / 后 / 至 / 到） 时移除，
        //    避免误删 "15:00时刻" / "15:00时段" 等用户主动使用的"时"字。
        result = result.replace(
            /(\d{1,2}:\d{2})时(?=$|[\s,，。、\-前后到至])/g,
            function (m, hhmm) {
                if (parseHHMMToMinutes(hhmm) == null) return m;
                return hhmm;
            }
        );

        return result;
    }

    /**
     * 从 data.publishTime 提取 HH:MM 部分
     * 入口会先执行标点规范化，兼容 `2026年7月18日11：45`（全角冒号）等场景
     * 同时容错识别 `;` / `；` 作为时间分隔符（中文输入法下用户可能误用分号代替冒号）
     * @param {string} publishTime 形如 "2026年7月18日11:45"
     * @returns {string} "11:45"；解析失败返回 ''
     */
    function extractPublishHHMM(publishTime) {
        if (!publishTime) return '';
        var normalized = normalizePunctuation(publishTime);
        // 兼容 `:` 与 `;`（前者为标准时间分隔符；后者为用户误用分号的容错写法）
        var m = String(normalized).match(/(\d{1,2})[:;](\d{2})/);
        if (!m) return '';
        return m[1] + ':' + m[2];
    }

    /**
     * 从 data.publishTime 提取 yyyy-MM-dd 格式日期
     * 支持两种输入格式：
     *   - 中文格式："2026年7月18日14:03" → "2026-07-18"
     *   - ISO 格式："2026-07-18 14:03" / "2026-07-18" → "2026-07-18"
     * 入口先执行标点规范化（防御性，正常场景下标点不影响日期提取）
     * @param {string} publishTime 发布时间文本
     * @returns {string} "yyyy-MM-dd"；解析失败返回 ''
     */
    function extractPublishDate(publishTime) {
        if (!publishTime) return '';
        var normalized = normalizePunctuation(publishTime);
        // 1) 优先匹配中文格式 "2026年7月18日"
        var cn = String(normalized).match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
        if (cn) {
            return cn[1] + '-' + pad2(parseInt(cn[2], 10)) + '-' + pad2(parseInt(cn[3], 10));
        }
        // 2) 兜底匹配 ISO 格式 "2026-07-18"
        var iso = String(normalized).match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
        if (iso) {
            return iso[1] + '-' + pad2(parseInt(iso[2], 10)) + '-' + pad2(parseInt(iso[3], 10));
        }
        return '';
    }

    /**
     * 预警等级单字 → 中文（如 "红" → "红色"）
     * @param {string} level
     * @returns {string}
     */
    function levelToChinese(level) {
        var map = { '红': '红色', '橙': '橙色', '黄': '黄色' };
        return map[level] || level || '';
    }

    /**
     * 把预警表单数据转换为一行 Excel 记录
     * 列顺序（与 HEADERS 一致，共 11 列）：
     *   [0]  counter     序号（行号），来自参数；缺失时填空字符串
     *   [1]  date        日期（yyyy-MM-dd，来自 data.publishTime）
     *   [2]  airport     影响机场
     *   [3]  level       预警等级（已转中文）
     *   [4]  phenomenon  天气类型
     *   [5]  forecast    预警内容
     *   [6]  publishHHMM 发布时间（HH:MM）
     *   [7]  period      发生时段
     *   [8]  duration    预报时长（纯数字；单位 h 由列标题承担）
     *   [9]  producer    制作人
     *   [10] serialNo    发布序号（来自 data.serialNo，缺失填空字符串）
     * @param {object} data 预警表单数据
     * @param {string|number} [counter] 序号计数器（行号）；缺失或 falsy 时填空字符串
     *   - 期望调用方传入字符串化的数字（如 '1'、'2'），以避免 Excel 显示 '1.0'
     *   - 也可传入数字，内部统一用 String() 转换
     * @returns {string[]} 11 元素数组
     */
    function buildRow(data, counter) {
        var publishHHMM = extractPublishHHMM(data.publishTime);
        var period = parsePeriod(data.forecast, publishHHMM);
        var duration = computeDuration(period);
        var date = extractPublishDate(data.publishTime);

        // counter 缺失或 falsy 时填空字符串（保证 buildRow 单独调用不报错）
        var counterStr = (counter === undefined || counter === null || counter === '')
            ? ''
            : String(counter);

        return [
            counterStr,                       // 索引 0: 序号（行号，纯计数器）
            date,                             // 索引 1: 日期（yyyy-MM-dd）
            data.airport || '',               // 索引 2: 影响机场
            levelToChinese(data.level),       // 索引 3: 预警等级
            data.phenomenon || '',            // 索引 4: 天气类型
            data.forecast || '',              // 索引 5: 预警内容
            publishHHMM,                      // 索引 6: 发布时间
            period,                           // 索引 7: 发生时段
            duration,                         // 索引 8: 预报时长
            data.producer || '',              // 索引 9: 制作人
            data.serialNo || ''               // 索引 10: 发布序号（如 20260718001）
        ];
    }

    /* ============================================================
     * 存储管理（chrome.storage.local）
     * ============================================================ */

    /**
     * 读取当日记录
     * @param {string} dateStamp yyyyMMdd
     * @returns {Array<string[]>}
     */
    function getLog(dateStamp) {
        if (!global.Storage || typeof global.Storage.get !== 'function') return [];
        try {
            var log = global.Storage.get(STORAGE_KEY);
            if (!log) return [];
            return log[dateStamp] || [];
        } catch (e) {
            if (global.Logger) global.Logger.warn('warning record log read failed', e && e.message);
            return [];
        }
    }

    /**
     * 写入当日记录（追加）
     * @param {string} dateStamp
     * @param {string[]} row
     * @returns {Array<string[]>} 写入后的当日全部记录
     */
    function appendLog(dateStamp, row) {
        var all = getLog(dateStamp);
        all.push(row);
        var log = {};
        try {
            var existing = global.Storage.get(STORAGE_KEY) || {};
            log = existing;
        } catch (e) {
            log = {};
        }
        log[dateStamp] = all;
        if (global.Storage && typeof global.Storage.set === 'function') {
            try {
                global.Storage.set(STORAGE_KEY, log);
            } catch (e) {
                if (global.Logger) global.Logger.warn('warning record log write failed', e && e.message);
            }
        }
        return all;
    }

    /**
     * 清除当日记录（调试用）
     * @param {string} dateStamp
     */
    function clearLog(dateStamp) {
        if (!global.Storage) return;
        try {
            var log = global.Storage.get(STORAGE_KEY) || {};
            delete log[dateStamp];
            global.Storage.set(STORAGE_KEY, log);
        } catch (e) { /* ignore */ }
    }

    /**
     * 读取所有日期的全部历史记录
     * @returns {Array<{dateStamp:string, rowIndex:number, row:string[]}>}
     *          按时间倒序返回（最新在前）
     */
    function getAllLogs() {
        if (!global.Storage || typeof global.Storage.get !== 'function') return [];
        try {
            var log = global.Storage.get(STORAGE_KEY);
            if (!log) return [];
            var out = [];
            Object.keys(log).sort().reverse().forEach(function (dateStamp) {
                var rows = log[dateStamp] || [];
                rows.forEach(function (row, rowIndex) {
                    if (!row || !row.length) return;
                    out.push({ dateStamp: dateStamp, rowIndex: rowIndex, row: row });
                });
            });
            return out;
        } catch (e) {
            if (global.Logger) global.Logger.warn('warning record getAllLogs failed', e && e.message);
            return [];
        }
    }

    /**
     * 删除单条历史记录
     * @param {string} dateStamp yyyyMMdd
     * @param {number} rowIndex 行索引
     * @returns {boolean} 是否成功
     */
    function removeRecord(dateStamp, rowIndex) {
        if (!global.Storage || typeof global.Storage.get !== 'function') return false;
        try {
            var log = global.Storage.get(STORAGE_KEY) || {};
            var rows = log[dateStamp];
            if (!Array.isArray(rows) || rowIndex < 0 || rowIndex >= rows.length) return false;
            rows.splice(rowIndex, 1);
            if (rows.length === 0) {
                delete log[dateStamp];
            } else {
                log[dateStamp] = rows;
            }
            global.Storage.set(STORAGE_KEY, log);
            return true;
        } catch (e) {
            if (global.Logger) global.Logger.warn('warning record removeRecord failed', e && e.message);
            return false;
        }
    }

    /**
     * 清除全部历史记录
     * @returns {boolean} 是否成功
     */
    function clearAllLogs() {
        if (!global.Storage || typeof global.Storage.set !== 'function') return false;
        try {
            global.Storage.set(STORAGE_KEY, {});
            return true;
        } catch (e) {
            if (global.Logger) global.Logger.warn('warning record clearAllLogs failed', e && e.message);
            return false;
        }
    }

    /* ============================================================
     * Excel 写入
     * ============================================================ */

    /**
     * 应用单元格样式
     * 参考 exporter-xlsx.js 的 applyCellStyles 风格
     * - 全部水平+垂直居中
     * - 表头加粗 11pt
     * - 有内容单元格：四周黑色实线边框
     * - 自动换行
     * @param {object} ws XLSX worksheet
     * @param {string[][]} aoa 数据
     */
    function applyCellStyles(ws, aoa) {
        if (!ws || !aooCheck(aoa)) return;
        var range = global.XLSX.utils.decode_range(ws['!ref']);
        var thinBorder = {
            top: { style: 'thin', color: { rgb: 'FF000000' } },
            right: { style: 'thin', color: { rgb: 'FF000000' } },
            bottom: { style: 'thin', color: { rgb: 'FF000000' } },
            left: { style: 'thin', color: { rgb: 'FF000000' } }
        };
        var centerAlignment = { horizontal: 'center', vertical: 'center', wrapText: true };

        for (var R = range.s.r; R <= range.e.r; R++) {
            for (var C = range.s.c; C <= range.e.c; C++) {
                var addr = global.XLSX.utils.encode_cell({ r: R, c: C });
                var cell = ws[addr];
                if (!cell) continue;
                var value = aoa[R] && aoa[R][C] !== undefined ? aoa[R][C] : cell.v;
                var hasContent = value !== undefined && value !== null && String(value).length > 0;
                if (!hasContent) continue;

                if (!cell.s) cell.s = {};
                cell.s.alignment = { horizontal: 'center', vertical: 'center', wrapText: true };
                // 表头加粗 11pt
                if (R === 0) {
                    cell.s.font = Object.assign({}, cell.s.font || {}, { sz: 11, bold: true });
                } else {
                    // 数据行：11pt 常规（与参考模板一致）
                    cell.s.font = Object.assign({}, cell.s.font || {}, { sz: 11, bold: false });
                }
                cell.s.border = {
                    top: { style: 'thin', color: { rgb: 'FF000000' } },
                    right: { style: 'thin', color: { rgb: 'FF000000' } },
                    bottom: { style: 'thin', color: { rgb: 'FF000000' } },
                    left: { style: 'thin', color: { rgb: 'FF000000' } }
                };
            }
        }
    }

    /** aoa 合法性检查（防御性） */
    function aooCheck(aoa) {
        return aoa && Array.isArray(aoa) && aoa.length > 0;
    }

    /**
     * 根据 aoa 计算每行的行高
     * 表头 24pt，数据行基础 22pt + 超出字符的折行
     * @param {string[][]} aoa
     * @returns {Array<{hpt:number}>}
     */
    function computeRowHeights(aoa) {
        var heights = [];
        for (var ri = 0; ri < aoa.length; ri++) {
            var maxLines = 1;
            if (ri === 0) {
                // 表头
                heights.push({ hpt: 24 });
                continue;
            }
            for (var ci = 0; ci < aoa[ri].length; ci++) {
                var cell = String(aoa[ri][ci] || '');
                // 换行符数量
                var lines = (cell.match(/\n/g) || []).length + 1;
                // 中文字符较长时估算折行：单列 11pt 大约 14-16 字符/行
                if (cell.length > 16) {
                    lines += Math.ceil((cell.length - 16) / 14);
                }
                if (lines > maxLines) maxLines = lines;
            }
            // 基础 22pt + 多出每行 18pt
            heights.push({ hpt: 22 + (maxLines - 1) * 18 });
        }
        return heights;
    }

    /**
     * 触发 Excel 下载
     * @param {string[][]} aoa 行数据（含表头）
     * @param {string} filename
     */
    function writeAndDownload(aoa, filename) {
        if (typeof global.XLSX === 'undefined') {
            throw new Error('XLSX 库未加载，请确认 assets/vendor/xlsx.bundle.js 已引入');
        }
        var ws = global.XLSX.utils.aoa_to_sheet(aoa);

        // 列宽（与 HEADERS 一一对应，共 11 列；列宽参考 10pt 宋体可读宽度）
        ws['!cols'] = [
            { wch: 8 },   // A 序号（行号，纯计数器）
            { wch: 12 },  // B 日期（yyyy-MM-dd）
            { wch: 12 },  // C 影响机场
            { wch: 10 },  // D 预警等级
            { wch: 12 },  // E 天气类型
            { wch: 50 },  // F 预警内容（最宽）
            { wch: 10 },  // G 发布时间
            { wch: 18 },  // H 发生时段
            { wch: 12 },  // I 预报时长(h)
            { wch: 10 },  // J 制作人
            { wch: 14 }   // K 发布序号（如 20260718001）
        ];

        // 行高
        ws['!rows'] = computeRowHeights(aoa);

        // 单元格样式
        applyCellStyles(ws, aoa);

        var wb = global.XLSX.utils.book_new();
        global.XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
        var out = global.XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
        var blob = new Blob([out], { type: 'application/octet-stream' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        setTimeout(function () {
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        }, 100);
    }

    /* ============================================================
     * 对外 API
     * ============================================================ */

    /**
     * 将预警记录追加到历史预警存储（仅写入 chrome.storage.local，不下载 Excel）
     * 用于"一键截图"等不需要 Excel 下载、但需要展示历史预警卡片的场景
     * - 计算 counter（基于当日已有记录数 + 1）
     * - 复用 buildRow / normalizeRowTo11Cols 保持 11 列布局一致
     * - 跨日会自动切换到新 dateStamp
     * @param {object} data 预警表单数据 { airport, level, phenomenon, publishTime, forecast, producer, serialNo }
     * @returns {{success: boolean, message: string, row?: string[], dateStamp?: string}}
     */
    function addRecord(data) {
        try {
            if (!data) {
                return { success: false, message: '无预警数据' };
            }
            var parts = getBeijingParts(new Date());
            var dateStamp = parts.dateStamp;

            // 1. 读取当日已有记录
            var existingRows = getLog(dateStamp);

            // 2. 计算 counter（字符串化，避免 Excel 显示 1.0）
            var newCounter = String(existingRows.length + 1);

            // 3. 构建当前行（11 列布局）
            var row = buildRow(data, newCounter);

            // 4. 追加到 storage（appendLog 内部会自动归一化旧数据为 11 列）
            appendLog(dateStamp, row);

            if (global.Logger) {
                global.Logger.info('warning record added to history', {
                    dateStamp: dateStamp,
                    counter: row[0],
                    airport: row[2],
                    level: row[3],
                    serialNo: row[10]
                });
            }

            return { success: true, message: '已加入历史预警', row: row, dateStamp: dateStamp };
        } catch (e) {
            if (global.Logger) {
                global.Logger.error('warning record addRecord failed', e && e.message);
            }
            return { success: false, message: '加入历史预警失败: ' + (e && e.message || '未知错误') };
        }
    }

    /**
     * 导出预警记录到 Excel
     * - 默认模式：把当前表单 data 作为新行追加到当日记录，再导出当日全部记录
     * - mode='only-existing'：仅导出"历史预警机场"模块已存储的全部历史记录，不追加当前表单数据
     *                       此时 data 参数可省略/传 null；按日期升序+行索引升序排序后输出
     * @param {object} [data] 预警表单数据 { airport, level, phenomenon, publishTime, forecast, producer, ... }
     * @param {object} [options] { skipPersist?: boolean, timeHHmmss?: string, mode?: 'only-existing' }
     * @returns {{success: boolean, message: string, row?: string[], filename?: string, rowCount?: number}}
     */
    function exportRecord(data, options) {
        var opts = options || {};
        var isOnlyExisting = opts.mode === 'only-existing';
        try {
            var parts = getBeijingParts(new Date());
            var dateStamp = parts.dateStamp;
            var allRows = [];

            if (isOnlyExisting) {
                // 仅导出"历史预警机场"模块已存储的全部记录（跨日期）
                // 入口要求：data 不必提供（即使提供也忽略），不调用 appendLog，不消费发布序号
                var allLogs = (typeof getAllLogs === 'function') ? getAllLogs() : [];
                if (!allLogs.length) {
                    return { success: false, message: '暂无历史预警记录可导出' };
                }
                // 按日期升序 + 行索引升序排序，得到时间正序的导出顺序
                allLogs.sort(function (a, b) {
                    if (a.dateStamp !== b.dateStamp) {
                        return a.dateStamp < b.dateStamp ? -1 : 1;
                    }
                    return a.rowIndex - b.rowIndex;
                });
                allRows = allLogs.map(function (entry) { return entry.row; });
            } else {
                // 追加当前表单数据为新行后导出当日全部记录（保留旧行为）
                if (!data) {
                    return { success: false, message: '无预警数据' };
                }
                var existingRows = opts.skipPersist ? [] : getLog(dateStamp);
                // 1. 为新行计算 counter（字符串化的 existingRows.length + 1，确保 A 列从 1 开始连续）
                //    使用 String() 而非 number，避免 Excel 显示 '1.0'
                var newCounter = String(existingRows.length + 1);
                // 2. 构建当前行（11 列布局，含 counter）
                var row = buildRow(data, newCounter);
                // 3. 追加当前行
                allRows = existingRows.concat([row]);
                // 4. 写入 chrome.storage.local（持久化新行，新行已含 counter）
                if (!opts.skipPersist) {
                    appendLog(dateStamp, row);
                }
            }

            // 5. 统一回填 counter：所有记录按 1..N 重新计算
            //    - 跨日期导出时把每天的 A 列序号也连续起来
            //    - 处理历史 10 列旧数据 + 旧 11 列 counter 漂移
            //    旧 10 列布局：0=date, 1=serialNo, 2=airport, ..., 9=producer
            //    新 11 列布局：0=counter, 1=date, 2=airport, ..., 9=producer, 10=serialNo
            for (var i = 0; i < allRows.length; i++) {
                allRows[i] = normalizeRowTo11Cols(allRows[i]);
                allRows[i][0] = String(i + 1);
            }

            // 6. 生成文件名（仅导出模式同样使用操作时的时间戳，避免覆盖）
            var filename = getRecordFilename(dateStamp, opts.timeHHmmss);

            // 7. 构建 aoa（表头 + 全部数据行）
            var aoa = [HEADERS].concat(allRows);

            // 8. 触发下载
            writeAndDownload(aoa, filename);

            // 9. 记录日志
            if (global.Logger) {
                global.Logger.info('warning record exported', {
                    file: filename,
                    rowCount: allRows.length,
                    mode: isOnlyExisting ? 'only-existing' : 'append',
                    counter: isOnlyExisting ? null : (allRows[allRows.length - 1] && allRows[allRows.length - 1][0]),
                    period: isOnlyExisting ? null : (allRows[allRows.length - 1] && allRows[allRows.length - 1][7]),
                    duration: isOnlyExisting ? null : (allRows[allRows.length - 1] && allRows[allRows.length - 1][8]),
                    serialNo: isOnlyExisting ? null : (allRows[allRows.length - 1] && allRows[allRows.length - 1][10])
                });
            }

            return {
                success: true,
                message: '已导出 ' + filename,
                rowCount: allRows.length,
                filename: filename
            };
        } catch (e) {
            if (global.Logger) {
                global.Logger.error('warning record export failed', e && e.message);
            }
            return { success: false, message: '导出失败: ' + (e && e.message || '未知错误') };
        }
    }

    /**
     * 将历史记录行补全为 11 列布局（防御性，兼容旧 10 列数据）
     * 旧 10 列布局：0=date, 1=serialNo, 2=airport, 3=level, 4=phenomenon, 5=forecast, 6=publishHHMM, 7=period, 8=duration, 9=producer
     * 新 11 列布局：0=counter, 1=date, 2=airport, 3=level, 4=phenomenon, 5=forecast, 6=publishHHMM, 7=period, 8=duration, 9=producer, 10=serialNo
     * 注：行 [0] 的 counter 由 exportRecord 在回填阶段统一覆盖，本函数只负责按 11 列布局补全并迁移 serialNo
     * @param {string[]} row 原始行（10 元素或 11 元素）
     * @returns {string[]} 11 元素数组
     */
    function normalizeRowTo11Cols(row) {
        if (!row || !Array.isArray(row)) {
            // 防御性：非数组视为空行
            return new Array(11).fill('');
        }
        if (row.length >= 11) {
            // 已是 11 列布局：截断到 11 元素（防御性，避免历史 12+ 列污染）
            return row.slice(0, 11);
        }
        if (row.length === 10) {
            // 旧 10 列布局：serialNo 在 [1]，需移至 [10]
            var padded = new Array(11);
            padded[0] = '';  // counter 由调用方回填
            padded[1] = row[0] !== undefined ? row[0] : '';  // date
            padded[2] = row[2] !== undefined ? row[2] : '';  // airport
            padded[3] = row[3] !== undefined ? row[3] : '';  // level
            padded[4] = row[4] !== undefined ? row[4] : '';  // phenomenon
            padded[5] = row[5] !== undefined ? row[5] : '';  // forecast
            padded[6] = row[6] !== undefined ? row[6] : '';  // publishHHMM
            padded[7] = row[7] !== undefined ? row[7] : '';  // period
            padded[8] = row[8] !== undefined ? row[8] : '';  // duration
            padded[9] = row[9] !== undefined ? row[9] : '';  // producer
            padded[10] = row[1] !== undefined ? row[1] : ''; // serialNo 从 [1] 迁移到 [10]
            return padded;
        }
        // 其他长度（罕见，如 0/小于 10）：按位置补全到 11 元素
        var fallback = new Array(11).fill('');
        for (var k = 0; k < row.length; k++) {
            fallback[k] = row[k] !== undefined ? row[k] : '';
        }
        return fallback;
    }

    /* ============================================================
     * 暴露 API
     * ============================================================ */
    global.WarningRecordExporter = {
        parsePeriod: parsePeriod,
        computeDuration: computeDuration,
        formatHours: formatHours,
        computeDurationHours: computeDurationHours,
        extractTimePatterns: extractTimePatterns,
        extractPublishHHMM: extractPublishHHMM,
        extractPublishDate: extractPublishDate,
        normalizePunctuation: normalizePunctuation,
        normalizeTimeFormats: normalizeTimeFormats,
        getRecordFilename: getRecordFilename,
        getBeijingParts: getBeijingParts,
        buildRow: buildRow,
        addRecord: addRecord,
        exportRecord: exportRecord,
        getLog: getLog,
        clearLog: clearLog,
        getAllLogs: getAllLogs,
        removeRecord: removeRecord,
        clearAllLogs: clearAllLogs,
        // 内部方法，暴露给测试使用
        _applyCellStyles: applyCellStyles,
        _computeRowHeights: computeRowHeights,
        _writeAndDownload: writeAndDownload,
        _normalizeRowTo11Cols: normalizeRowTo11Cols
    };
})(window);
