/**
 * 气象简报机场预警截图模块
 * --------------------------------------------------------------------
 * 职责
 *   - 收集 NextDayRiskModule 已录入的风险条目
 *   - 拆分为「国内 / 国际」两个数据区，按 红→橙→黄 顺序排列
 *   - 用 HTML5 Canvas 自绘 5 列表格（关注 / 机场 / 天气类型 / 气象预报 / 时间段）
 *   - 关注等级列：vMerge 整列底色 + 仅首行显示文字标签
 *   - 等级缺失自动跳过：0 条红/橙/黄 → 不画该分组
 *   - 国内 0 条 → 不画国内表；国外 0 条 → 不画国外表
 *   - 生成 PNG 后：弹窗预览 + 自动复制剪贴板 + 提供"下载 PNG"兜底
 *
 * 数据契约（输入 risks 数组元素）
 *   {
 *     level: '红' | '橙' | '黄',
 *     icao: 'ZYTX' | 'VVTS' 等,
 *     weatherTypes: ['雷雨', '大风'],
 *     forecast: '...',
 *     startTime: { ok: true, value: '2026/7/20 06:00:00' },
 *     endTime:   { ok: true, value: '2026/7/20 18:00:00' }
 *   }
 *
 * 暴露对象：window.AirportWarningScreenshot
 *   - handleButtonClick()         入口：从 NextDayRiskModule 取数据 → 生成 → 预览 → 复制
 *   - generate(risks)             返回 { canvas, blob, dataUrl }
 *   - copyToClipboard(blob)       异步：调用 navigator.clipboard.write
 *   - showPreview(canvas)         显示弹窗预览
 *   - _drawTableToCanvas(...)     自绘画布（纯函数，便于单测）
 *   - _buildDomesticRows(risks)   国内行构造 + 排序
 *   - _buildForeignRows(risks)    国外行构造 + 排序
 *   - _formatTimeForScreenshot(v) "2026/7/20 06:00:00" → "0600"
 *
 * 依赖
 *   - airports.js: AirportTemplate.getNameByIcao / isDomestic
 *   - next-day-risk.js: NextDayRiskModule.getRisks
 *   - logger.js: Logger.info / warn / error
 */
(function (global) {
    'use strict';

    /* ============================================================
     * 常量
     * ============================================================ */

    /** 画布总宽（与列宽总和保持一致：70+90+100+250+90 = 600） */
    var CANVAS_WIDTH = 600;

    /** 5 列宽度：关注 / 机场 / 天气类型 / 气象预报 / 时间段 */
    var COL_WIDTHS = [70, 90, 100, 250, 90];

    /** 行高下限（保证视觉对齐，表头/单行内容使用） */
    var ROW_HEIGHT = 36;

    /** 内容换行后每行额外高度（字体 12px 行距 + 上下留白） */
    var WRAP_LINE_HEIGHT = 18;

    /** 内容垂直上下留白（px） */
    var WRAP_VERTICAL_PADDING = 12;

    /**
     * 高清缩放因子：所有内部坐标用逻辑像素，最后通过 ctx.scale(SCALE, SCALE) 放大
     * SCALE = 2 表示实际像素为逻辑像素的 2 倍（Retina 级别）
     * 调整后 canvas.width = CANVAS_WIDTH * SCALE
     */
    var SCALE = 2;

    /**
     * 细框线宽度（逻辑像素）
     * 在 2x 缩放下实际渲染 0.5 * 2 = 1 物理像素（hairline），视觉上更细腻
     */
    var BORDER_LINE_WIDTH = 0.5;

    /** 表头背景色 */
    var HEADER_FILL = '#FFFFFF';

    /** 数据行背景色 */
    var DATA_FILL = '#FFFFFF';

    /** 边框颜色 */
    var BORDER_COLOR = '#000000';

    /** 等级配置：颜色 / 文字色 / 显示标签 / 排序权重 */
    var LEVEL_INFO = {
        '红': { label: '高度关注', color: '#FF0000', textColor: '#FFFFFF', order: 0 },
        '橙': { label: '中度关注', color: '#FFC000', textColor: '#000000', order: 1 },
        '黄': { label: '一般关注', color: '#FFFF00', textColor: '#000000', order: 2 }
    };

    /** 国内展示顺序 */
    var DOMESTIC_LEVEL_ORDER = ['红', '橙', '黄'];

    /** 国外展示顺序：与国内一致（红→橙→黄），等级缺失时跳过 */
    var FOREIGN_LEVEL_ORDER = ['红', '橙', '黄'];

    /** 需要展示跑道号的天气类型（命中任一即显示） */
    var RUNWAY_TRIGGER_WEATHERS = ['顺风', '侧风', '大风'];

    /** 取消/删除行背景色（灰色填充） */
    var DELETED_ROW_FILL = '#BFBFBF';

    /** 取消项 modType 统一展示标签（与示例截图「西双版纳（取消）」一致） */
    var DELETED_ROW_LABEL = '取消';

    /* ============================================================
     * 工具函数
     * ============================================================ */

    /**
     * 获取机场中文名（依赖 airports.js）
     * @param {string} icao
     * @returns {string}
     */
    function getAirportName(icao) {
        if (!icao) return '';
        if (global.AirportTemplate && typeof global.AirportTemplate.getNameByIcao === 'function') {
            return global.AirportTemplate.getNameByIcao(icao) || icao;
        }
        return String(icao);
    }

    /**
     * 获取机场跑道号（依赖 airport-map.js 的 runwayByIcao）
     * 多跑道时返回以「、」分隔的字符串，如「03/21、04L/22R、04R/22L」；无数据返回 ''
     * @param {string} icao
     * @returns {string}
     */
    function getRunwayForIcao(icao) {
        if (!icao) return '';
        if (global.AirportMap && global.AirportMap.runwayByIcao) {
            return global.AirportMap.runwayByIcao[String(icao).toUpperCase()] || '';
        }
        return '';
    }

    /**
     * 判断 ICAO 是否为国内机场（依赖 airports.js / 兜底正则）
     * @param {string} icao
     * @returns {boolean}
     */
    function isDomesticIcao(icao) {
        if (!icao) return false;
        if (global.AirportTemplate && typeof global.AirportTemplate.isDomestic === 'function') {
            return global.AirportTemplate.isDomestic(icao);
        }
        return /^Z[A-Z]/.test(String(icao).toUpperCase());
    }

    /**
     * 归一化修改标记标签（前一日存档的 modType）
     *   - 兼容旧数据：'取消' 统一展示为 '删除'
     *   - 仅展示新增/删除/修订/升级/降级；其余（如无标记）返回 null
     * @param {string} modType
     * @returns {string|null}
     */
    function normalizeModLabel(modType) {
        if (!modType) return null;
        if (modType === '取消') modType = '删除';
        return (['新增', '删除', '修订', '升级', '降级'].indexOf(modType) >= 0) ? modType : null;
    }

    /**
     * 判断某条风险是否为「已删除/已取消」（modType 为 删除 或 取消）
     * @param {object} r 原始风险对象（含 modType 字段）
     * @returns {boolean}
     */
    function isDeletedRisk(r) {
        if (!r) return false;
        return r.modType === '删除' || r.modType === '取消';
    }

    /**
     * 时间格式化："2026/7/20 06:00:00" → "0600"
     *   - 完整 yyyy/m/d HH:mm:ss → 提取 HHmm
     *   - 4 位 HHMM 简写（如 "0600"）→ 直接返回
     *   - 容忍 1 位小时（如 "6:00"）→ 补零为 "06"
     *   - 异常输入返回空字符串
     * @param {string} value
     * @returns {string}
     */
    function _formatTimeForScreenshot(value) {
        if (!value) return '';
        var s = String(value).trim();
        if (!s) return '';
        // 1) 4 位纯数字 HHMM 简写（无冒号）
        if (/^\d{4}$/.test(s)) {
            var hh4 = parseInt(s.substring(0, 2), 10);
            var mm4 = parseInt(s.substring(2, 4), 10);
            if (hh4 >= 0 && hh4 <= 23 && mm4 >= 0 && mm4 <= 59) {
                return s;
            }
            return '';
        }
        // 2) 匹配 HH:MM（容忍 HH 可能是 1 位）
        var m = s.match(/(\d{1,2}):(\d{2})/);
        if (!m) return '';
        var hh = m[1];
        var mm = m[2];
        // 补零：1 位小时 → 2 位
        if (hh.length < 2) hh = '0' + hh;
        return hh + mm;
    }

    /**
     * 判断结束时间是否为开始时间的第二天（结束日期 > 开始日期，即跨天）
     *   - 时间值格式如 "2026/7/20 06:00:00"，取日期分量比较
     *   - 仅含 HHMM 简写（无日期）时无法判断，返回 false
     * @param {string} startVal
     * @param {string} endVal
     * @returns {boolean}
     */
    function isNextDayRange(startVal, endVal) {
        function parseDate(val) {
            var m = String(val).match(/(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
            if (!m) return null;
            return {
                y: parseInt(m[1], 10),
                mo: parseInt(m[2], 10),
                d: parseInt(m[3], 10)
            };
        }
        var sd = parseDate(startVal);
        var ed = parseDate(endVal);
        if (!sd || !ed) return false;
        // 结束日期晚于开始日期 → 跨到第二天（或更晚）
        if (ed.y !== sd.y) return ed.y > sd.y;
        if (ed.mo !== sd.mo) return ed.mo > sd.mo;
        return ed.d > sd.d;
    }

    /**
     * 组装截图时间段文本："0500-0200"；跨天时结束时间加「次日」前缀 → "0500-次日0200"
     * @param {string} startVal
     * @param {string} endVal
     * @returns {string}
     */
    function formatTimeRangeForScreenshot(startVal, endVal) {
        var startText = _formatTimeForScreenshot(startVal);
        var endText = _formatTimeForScreenshot(endVal);
        if (!startText && !endText) return '';
        if (isNextDayRange(startVal, endVal)) {
            return startText + '-' + '次日' + endText;
        }
        return startText + '-' + endText;
    }

    /**
     * 通用行构造器：过滤 + 排序（红→橙→黄）+ 字段组装
     * @param {Array} risks
     * @param {function(string): boolean} filterFn
     * @returns {Array<{level, icao, airportName, weatherTypesStr, forecast, timeRange}>}
     */
    function buildRowsByFilter(risks, filterFn) {
        if (!Array.isArray(risks)) return [];
        var filtered = [];
        for (var i = 0; i < risks.length; i++) {
            var r = risks[i];
            if (!r || !r.icao || !r.level) continue;
            if (!filterFn(String(r.icao).toUpperCase())) continue;
            filtered.push(r);
        }
        // 先拆成两组：普通行 vs 已删除行
        var normal = [];
        var deleted = [];
        for (var fi = 0; fi < filtered.length; fi++) {
            if (isDeletedRisk(filtered[fi])) deleted.push(filtered[fi]);
            else normal.push(filtered[fi]);
        }
        // 普通行按 level 排序：红→橙→黄（order 字段越小越靠前）
        normal.sort(function (a, b) {
            var oa = (LEVEL_INFO[a.level] && LEVEL_INFO[a.level].order != null)
                ? LEVEL_INFO[a.level].order : 99;
            var ob = (LEVEL_INFO[b.level] && LEVEL_INFO[b.level].order != null)
                ? LEVEL_INFO[b.level].order : 99;
            return oa - ob;
        });
        // 已删除行按用户录入顺序保持原顺序（按 ts 升序），最后统一拼到所有正常行之后
        deleted.sort(function (a, b) { return (a.ts || 0) - (b.ts || 0); });
        var merged = normal.concat(deleted);

        // 字段组装
        return merged.map(function (r) {
            var startVal = (r.startTime && r.startTime.value) || '';
            var endVal = (r.endTime && r.endTime.value) || '';
            var timeRange = formatTimeRangeForScreenshot(startVal, endVal);
            var wt = Array.isArray(r.weatherTypes) ? r.weatherTypes : [];
            var airportName = getAirportName(r.icao);
            var del = isDeletedRisk(r);
            // 修改标记：机场名称下换行显示，如「昆明\n（新增）」；
            // 取消/删除项：单独使用「取消」标签（与示例截图 西双版纳（取消）一致），避免与其它标记混用
            var modLabel;
            if (del) {
                modLabel = DELETED_ROW_LABEL;
            } else {
                modLabel = normalizeModLabel(r.modType);
            }

            // 跑道号：天气类型含 顺风/侧风/大风 时，机场名称下换行显示，如「芒市\n（05/23）」
            var runway = getRunwayForIcao(r.icao);
            var showRunway = runway && wt.some(function (t) {
                return RUNWAY_TRIGGER_WEATHERS.indexOf(t) >= 0;
            });

            // 组装机场文本：机场名 → 跑道号 → 修改/取消 标记，各占一行
            var airportTextLines = [airportName];
            if (showRunway) airportTextLines.push('（' + runway + '）');
            if (modLabel) airportTextLines.push('（' + modLabel + '）');
            var airportText = airportTextLines.join('\n');

            return {
                level: r.level,
                icao: r.icao,
                airportName: airportName,
                airportText: airportText,
                modLabel: modLabel,
                runway: showRunway ? runway : '',
                weatherTypesStr: wt.join('、'),
                forecast: r.forecast || '',
                timeRange: timeRange,
                // 标记：取消/删除行，需排到最后并使用灰色背景 + 不参与等级 vMerge
                isDeleted: del
            };
        });
    }

    /**
     * 构建国内机场数据行（ICAO 以 Z 开头）
     * @param {Array} risks
     * @returns {Array}
     */
    function _buildDomesticRows(risks) {
        return buildRowsByFilter(risks, isDomesticIcao);
    }

    /**
     * 构建国际机场数据行（非 Z 开头）
     * @param {Array} risks
     * @returns {Array}
     */
    function _buildForeignRows(risks) {
        return buildRowsByFilter(risks, function (icao) { return !isDomesticIcao(icao); });
    }

    /**
     * 按 level 分组（保持原顺序）
     * @param {Array} rows
     * @returns {Object<string, Array>}
     */
    function groupByLevel(rows) {
        var groups = { '红': [], '橙': [], '黄': [] };
        for (var i = 0; i < rows.length; i++) {
            var lvl = rows[i].level;
            if (groups[lvl]) groups[lvl].push(rows[i]);
        }
        return groups;
    }

    /**
     * 求前缀列宽之和（用于 x 坐标）
     * @param {number} upto
     * @returns {number}
     */
    function colX(upto) {
        var s = 0;
        for (var i = 0; i < upto; i++) s += COL_WIDTHS[i];
        return s;
    }

    /**
     * 简单中文/英文混合文本换行（中文字符宽度按 1em，英文字符按 0.55em 估算）
     * @param {CanvasRenderingContext2D} ctx
     * @param {string} text
     * @param {number} maxWidth
     * @returns {string[]}
     */
    function wrapText(ctx, text, maxWidth) {
        if (!text) return [''];
        if (typeof ctx.measureText !== 'function') return [String(text).split('\n')];
        var lines = [];
        // 先按显式换行符分段（如「昆明\n（新增）」），再对每段按宽度自动换行
        String(text).split('\n').forEach(function (seg) {
            if (seg === '') {
                lines.push('');
                return;
            }
            var current = '';
            for (var i = 0; i < seg.length; i++) {
                var ch = seg.charAt(i);
                var test = current + ch;
                var w = 0;
                try { w = ctx.measureText(test).width; } catch (e) { w = test.length * 12; }
                if (w > maxWidth && current.length > 0) {
                    lines.push(current);
                    current = ch;
                } else {
                    current = test;
                }
            }
            if (current) lines.push(current);
        });
        return lines.length > 0 ? lines : [''];
    }

    /**
     * 计算某文本在指定列宽下自动换行后的行数
     * 使用与 drawCell 相同的字体与内边距，保证行高估算与实际绘制一致
     * @param {CanvasRenderingContext2D} ctx
     * @param {string} text
     * @param {number} columnWidth 列宽（逻辑像素）
     * @param {number} fontSize 字号（默认 12）
     * @returns {number} 至少 1
     */
    function computeWrappedLines(ctx, text, columnWidth, fontSize) {
        if (!text) return 1;
        var fs = fontSize || 12;
        ctx.save();
        try {
            ctx.font = fs + 'px "PingFang SC", "Microsoft YaHei", "SimHei", "Heiti SC", sans-serif';
            var lines = wrapText(ctx, String(text), columnWidth - 8);
            return lines.length > 0 ? lines.length : 1;
        } finally {
            ctx.restore();
        }
    }

    /**
     * 计算一行数据所需高度（按内容自动换行展开）
     *   - 取「天气预报」与「天气类型」两列换行行数的较大值
     *   - 行高 = 行数 × 每行高度 + 上下留白，且不低于 ROW_HEIGHT
     * @param {CanvasRenderingContext2D} ctx
     * @param {object} rowData { weatherTypesStr, forecast, ... }
     * @returns {number} 该行逻辑高度（px）
     */
    function computeRowHeight(ctx, rowData) {
        if (!rowData) return ROW_HEIGHT;
        var airportLines = computeWrappedLines(ctx, rowData.airportText, COL_WIDTHS[1], 12);
        var forecastLines = computeWrappedLines(ctx, rowData.forecast, COL_WIDTHS[3], 12);
        var weatherLines = computeWrappedLines(ctx, rowData.weatherTypesStr, COL_WIDTHS[2], 12);
        var lines = Math.max(airportLines, forecastLines, weatherLines, 1);
        var h = lines * WRAP_LINE_HEIGHT + WRAP_VERTICAL_PADDING;
        return Math.max(ROW_HEIGHT, h);
    }

    /**
     * 绘制一个白底矩形单元格（带边框 + 居中文字，可选自动换行）
     * @param {CanvasRenderingContext2D} ctx
     * @param {number} x
     * @param {number} y
     * @param {number} w
     * @param {number} h
     * @param {string} text
     * @param {object} opts { fill, color, font, bold, wrap }
     */
    function drawCell(ctx, x, y, w, h, text, opts) {
        opts = opts || {};
        // 1) 背景
        var fill = (opts.fill != null) ? opts.fill : DATA_FILL;
        if (fill) {
            ctx.fillStyle = fill;
            ctx.fillRect(x, y, w, h);
        }
        // 2) 边框（细线）
        ctx.strokeStyle = BORDER_COLOR;
        ctx.lineWidth = BORDER_LINE_WIDTH;
        ctx.strokeRect(x + BORDER_LINE_WIDTH / 2, y + BORDER_LINE_WIDTH / 2, w - BORDER_LINE_WIDTH, h - BORDER_LINE_WIDTH);
        // 3) 文字
        if (text !== undefined && text !== null && text !== '') {
            ctx.fillStyle = opts.color || '#000000';
            var weight = opts.bold ? 'bold ' : '';
            ctx.font = weight + (opts.fontSize || 12) + 'px "PingFang SC", "Microsoft YaHei", "SimHei", "Heiti SC", sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';

            if (opts.wrap) {
                var lines = wrapText(ctx, String(text), w - 8);
                var lineH = (opts.fontSize || 12) + 2;
                // 行高已按内容自动扩展（见 computeRowHeight），此处完整绘制所有换行行，不再截断为省略号
                var totalH = lines.length * lineH;
                var startY = y + (h - totalH) / 2 + lineH / 2;
                for (var i = 0; i < lines.length; i++) {
                    ctx.fillText(lines[i], x + w / 2, startY + i * lineH);
                }
            } else {
                ctx.fillText(String(text), x + w / 2, y + h / 2);
            }
        }
    }

    /**
     * 绘制一个等级的 vMerge 关注列
     *   - 整列填充底色
     *   - 仅首行绘制文字标签（其它行留空）
     *   - 边框为外框（不含内部行分隔线在关注列内）
     * @param {CanvasRenderingContext2D} ctx
     * @param {number} x 关注列左上角 x
     * @param {number} y 关注列左上角 y（首行）
     * @param {number} groupHeight 组总高度
     * @param {string} level 等级（红/橙/黄）
     */
    function drawLevelColumn(ctx, x, y, groupHeight, level) {
        var info = LEVEL_INFO[level];
        if (!info) return;
        // 1) 整列底色
        ctx.fillStyle = info.color;
        ctx.fillRect(x, y, COL_WIDTHS[0], groupHeight);
        // 2) 外边框（细线）
        ctx.strokeStyle = BORDER_COLOR;
        ctx.lineWidth = BORDER_LINE_WIDTH;
        ctx.strokeRect(x + BORDER_LINE_WIDTH / 2, y + BORDER_LINE_WIDTH / 2, COL_WIDTHS[0] - BORDER_LINE_WIDTH, groupHeight - BORDER_LINE_WIDTH);
        // 3) 文字（vMerge 合并区域：水平居中 + 整个合并高度垂直居中）
        ctx.fillStyle = info.textColor;
        ctx.font = 'bold 12px "PingFang SC", "Microsoft YaHei", sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(info.label, x + COL_WIDTHS[0] / 2, y + groupHeight / 2);
    }

    /**
     * 绘制一个数据行（除关注列以外的所有列）
     *   - 取消/删除行：整行灰色填充（DELETED_ROW_FILL）
     * @param {CanvasRenderingContext2D} ctx
     * @param {number} x
     * @param {number} y
     * @param {object} rowData
     * @param {boolean} isForeign
     * @param {number} rowHeight 本行高度（按内容自动扩展）
     */
    function drawDataRow(ctx, x, y, rowData, isForeign, rowHeight) {
        var rh = rowHeight || ROW_HEIGHT;
        var fill = (rowData && rowData.isDeleted) ? DELETED_ROW_FILL : DATA_FILL;
        // 列 2: 机场（中文名，含修改/取消标记时换行显示，如「昆明\n（新增）」、「西双版纳\n（取消）」）
        drawCell(ctx, x + colX(1), y, COL_WIDTHS[1], rh, rowData.airportText, {
            fill: fill, color: '#000000', fontSize: 12, wrap: true
        });
        // 列 3: 天气类型
        drawCell(ctx, x + colX(2), y, COL_WIDTHS[2], rh, rowData.weatherTypesStr, {
            fill: fill, color: '#000000', fontSize: 12, wrap: true
        });
        // 列 4: 气象预报（自动换行，行高随内容扩展）
        drawCell(ctx, x + colX(3), y, COL_WIDTHS[3], rh, rowData.forecast, {
            fill: fill, color: '#000000', fontSize: 12, wrap: true
        });
        // 列 5: 时间段
        drawCell(ctx, x + colX(4), y, COL_WIDTHS[4], rh, rowData.timeRange, {
            fill: fill, color: '#000000', fontSize: 12
        });
        // isForeign 参数保留以备未来扩展（不同列名等）
        if (isForeign) { /* no-op */ }
    }

    /**
     * 绘制表头：5 列白底 + 加粗 14 号字
     * @param {CanvasRenderingContext2D} ctx
     * @param {number} x
     * @param {number} y
     * @param {boolean} isForeign
     */
    function drawHeader(ctx, x, y, isForeign) {
        var headers = isForeign
            ? ['关注', '国外机场', '天气类型', '气象预报', '时间段']
            : ['关注', '国内机场', '天气类型', '气象预报', '时间段'];
        for (var i = 0; i < headers.length; i++) {
            drawCell(ctx, x + colX(i), y, COL_WIDTHS[i], ROW_HEIGHT, headers[i], {
                fill: HEADER_FILL, color: '#000000', fontSize: 14, bold: true
            });
        }
    }

    /**
     * 绘制一个数据区（国内 / 国外）
     *   - 普通行：按 红→橙→黄 分组，关注列 vMerge 整列背景 + 首行文字
     *   - 取消/删除行：置于该区最后，逐行灰色单元格（关注列不再做 vMerge）
     * @param {CanvasRenderingContext2D} ctx
     * @param {number} x
     * @param {number} y
     * @param {Array} rows 已排序的该区行（红→橙→黄 后追加取消/删除行）
     * @param {boolean} isForeign
     * @returns {number} 绘制总高度（px）
     */
    function drawSection(ctx, x, y, rows, isForeign) {
        var curY = y;
        // 表头
        drawHeader(ctx, x, curY, isForeign);
        curY += ROW_HEIGHT;

        if (!rows || rows.length === 0) {
            return curY - y;
        }

        // 拆分：普通行（参与 vMerge 分组） / 取消行（独立显示在最后）
        var normalRows = [];
        var deletedRows = [];
        for (var ri = 0; ri < rows.length; ri++) {
            if (rows[ri] && rows[ri].isDeleted) deletedRows.push(rows[ri]);
            else normalRows.push(rows[ri]);
        }

        // ====== 第一部分：普通行按等级分组绘制（vMerge 关注列） ======
        var groups = groupByLevel(normalRows);
        var order = isForeign ? FOREIGN_LEVEL_ORDER : DOMESTIC_LEVEL_ORDER;

        for (var li = 0; li < order.length; li++) {
            var level = order[li];
            var groupRows = groups[level];
            if (!groupRows || groupRows.length === 0) continue;

            // 逐行计算高度（按内容自动换行展开）
            var rowHeights = [];
            var groupHeight = 0;
            for (var gri = 0; gri < groupRows.length; gri++) {
                var grh = computeRowHeight(ctx, groupRows[gri]);
                rowHeights.push(grh);
                groupHeight += grh;
            }
            // 关注列（vMerge 整列，高度 = 组内所有行高度之和）
            drawLevelColumn(ctx, x, curY, groupHeight, level);
            // 各数据行
            var rowY = curY;
            for (gri = 0; gri < groupRows.length; gri++) {
                drawDataRow(ctx, x, rowY, groupRows[gri], isForeign, rowHeights[gri]);
                rowY += rowHeights[gri];
            }
            curY += groupHeight;
        }

        // ====== 第二部分：取消/删除行逐行绘制（每一行的关注列都是灰色，不做 vMerge） ======
        for (var di = 0; di < deletedRows.length; di++) {
            var dr = deletedRows[di];
            var drh = computeRowHeight(ctx, dr);
            // 关注列：灰色单元格（无等级色，无标签文字）
            drawCell(ctx, x + colX(0), curY, COL_WIDTHS[0], drh, '', {
                fill: DELETED_ROW_FILL
            });
            // 其它 4 列：灰色背景
            drawDataRow(ctx, x, curY, dr, isForeign, drh);
            curY += drh;
        }

        return curY - y;
    }

    /**
     * 计算画布总高度（按内容自动换行逐行累加）
     * @param {CanvasRenderingContext2D} ctx
     * @param {Array} domesticRows
     * @param {Array} foreignRows
     * @returns {number}
     */
    function computeCanvasHeight(ctx, domesticRows, foreignRows) {
        var totalH = 0;
        if (domesticRows && domesticRows.length > 0) {
            totalH += ROW_HEIGHT; // 国内表头
            for (var i = 0; i < domesticRows.length; i++) totalH += computeRowHeight(ctx, domesticRows[i]);
        }
        if (foreignRows && foreignRows.length > 0) {
            totalH += ROW_HEIGHT; // 国外表头
            for (var j = 0; j < foreignRows.length; j++) totalH += computeRowHeight(ctx, foreignRows[j]);
        }
        // 至少 1 逻辑高度（避免 0 高度报错）
        if (totalH < 1) totalH = 1;
        return totalH;
    }

    /**
     * 核心：自绘 5 列表格到 Canvas
     *   - 国内表（若 domesticRows 非空）
     *   - 国外表（若 foreignRows 非空）：仅"中度关注"分组
     * @param {Array} domesticRows
     * @param {Array} foreignRows
     * @returns {HTMLCanvasElement}
     */
    function _drawTableToCanvas(domesticRows, foreignRows) {
        var canvas = null;
        try {
            if (typeof document !== 'undefined' && document && document.createElement) {
                canvas = document.createElement('canvas');
            }
        } catch (e) { /* ignore */ }
        if (!canvas) {
            // Node.js / SSR fallback：返回最小化占位 canvas，调用方应避免在 Node 中调用此函数
            canvas = { width: 0, height: 0, getContext: function () { return null; }, toDataURL: function () { return ''; }, toBlob: function (cb) { if (cb) cb(null); } };
            return canvas;
        }

        var d = domesticRows || [];
        var f = foreignRows || [];
        var ctx = canvas.getContext('2d');
        if (!ctx) return canvas;
        // 高清：实际像素 = 逻辑像素 × SCALE，便于插入 Word 后不模糊
        // 总高度按内容自动换行逐行累加（需 ctx 测量文本宽度）
        var logicalWidth = CANVAS_WIDTH;
        var logicalHeight = computeCanvasHeight(ctx, d, f);
        canvas.width = logicalWidth * SCALE;
        canvas.height = logicalHeight * SCALE;
        // 启用高清缩放：所有内部坐标按逻辑像素写，最后自动放大 SCALE 倍
        ctx.scale(SCALE, SCALE);
        // 白底（使用逻辑坐标，由 scale 自动放大）
        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(0, 0, logicalWidth, logicalHeight);

        var y = 0;
        if (d.length > 0) {
            y += drawSection(ctx, 0, y, d, false);
        }
        if (f.length > 0) {
            y += drawSection(ctx, 0, y, f, true);
        }

        return canvas;
    }

    /**
     * 将 Canvas 转为 PNG Blob（Promise 形式）
     * @param {HTMLCanvasElement} canvas
     * @returns {Promise<Blob>}
     */
    function canvasToBlob(canvas) {
        return new Promise(function (resolve, reject) {
            if (!canvas || typeof canvas.toBlob !== 'function') {
                reject(new Error('Canvas 或 toBlob 不可用'));
                return;
            }
            try {
                canvas.toBlob(function (blob) {
                    if (blob) resolve(blob);
                    else reject(new Error('Canvas toBlob 返回 null（可能画布为空或被污染）'));
                }, 'image/png');
            } catch (e) {
                if (global.Logger) global.Logger.error('canvasToBlob 异常', e && e.message);
                reject(new Error('canvas.toBlob 执行失败：' + (e && e.message)));
            }
        });
    }

    /**
     * 生成截图：返回 { canvas, blob, dataUrl }
     * @param {Array} risks
     * @returns {Promise<{canvas: HTMLCanvasElement, blob: Blob, dataUrl: string}>}
     */
    function generate(risks) {
        var arr = Array.isArray(risks) ? risks : [];
        var domesticRows = _buildDomesticRows(arr);
        var foreignRows = _buildForeignRows(arr);
        var canvas = _drawTableToCanvas(domesticRows, foreignRows);
        var dataUrl = '';
        try {
            if (typeof canvas.toDataURL === 'function') {
                dataUrl = canvas.toDataURL('image/png');
            }
        } catch (e) {
            if (global.Logger) global.Logger.warn('canvas.toDataURL 失败：' + (e && e.message));
        }
        return canvasToBlob(canvas).then(function (blob) {
            return { canvas: canvas, blob: blob, dataUrl: dataUrl };
        });
    }

    /**
     * 复制 PNG Blob 到剪贴板
     *   - 失败时 reject，附带错误信息供调用方决定是否回退到下载按钮
     *   - 区分 Image-only ClipboardItem 错误（Safari 限制）
     * @param {Blob} blob
     * @returns {Promise<void>}
     */
    function copyToClipboard(blob) {
        return new Promise(function (resolve, reject) {
            if (!blob) {
                reject(new Error('无效的 Blob'));
                return;
            }
            // 优先：异步 Clipboard API
            if (global.navigator && global.navigator.clipboard && typeof global.navigator.clipboard.write === 'function') {
                try {
                    var ClipboardItemCtor = global.ClipboardItem || (typeof window !== 'undefined' ? window.ClipboardItem : null);
                    if (typeof ClipboardItemCtor === 'function') {
                        var item = new ClipboardItemCtor({ 'image/png': blob });
                        global.navigator.clipboard.write([item]).then(function () {
                            resolve();
                        }).catch(function (err) {
                            reject(new Error('剪贴板写入被拒绝：' + (err && err.message ? err.message : 'unknown')));
                        });
                        return;
                    }
                    reject(new Error('ClipboardItem 不可用（Safari 限制？）'));
                    return;
                } catch (e) {
                    reject(new Error('剪贴板写入异常：' + (e && e.message)));
                    return;
                }
            }
            reject(new Error('当前环境不支持 navigator.clipboard.write API'));
        });
    }

    /* ============================================================
     * 弹窗预览
     * ============================================================ */

    var modalElements = null;
    var escListenerBound = false;

    /**
     * 收集弹窗 DOM 元素引用（首次调用时执行）
     */
    function ensureModalElements() {
        if (modalElements) return modalElements;
        if (typeof document === 'undefined' || !document.getElementById) {
            modalElements = {};
            return modalElements;
        }
        modalElements = {
            modal: document.getElementById('screenshot-modal'),
            img: document.getElementById('screenshot-modal-img'),
            toast: document.getElementById('screenshot-modal-toast'),
            close: document.getElementById('screenshot-modal-close'),
            confirm: document.getElementById('screenshot-modal-confirm'),
            download: document.getElementById('screenshot-modal-download'),
            backdrop: null
        };
        // backdrop: 第一个 .screenshot-modal__backdrop
        if (modalElements.modal) {
            var backs = modalElements.modal.querySelectorAll('.screenshot-modal__backdrop');
            if (backs && backs.length > 0) modalElements.backdrop = backs[0];
        }
        return modalElements;
    }

    /**
     * 显示 Toast 提示
     * @param {string} msg
     * @param {string} type 'success' | 'warn' | 'error'
     */
    function showToast(msg, type) {
        var el = modalElements && modalElements.toast;
        if (!el) return;
        el.textContent = msg || '';
        el.className = 'screenshot-modal__toast' + (type ? ' screenshot-modal__toast--' + type : '');
        el.hidden = !msg;
    }

    /**
     * 关闭弹窗
     */
    function closeModal() {
        if (!modalElements || !modalElements.modal) return;
        modalElements.modal.hidden = true;
        modalElements.modal.setAttribute('aria-hidden', 'true');
        if (modalElements.toast) modalElements.toast.hidden = true;
    }

    /**
     * 触发下载 PNG
     */
    function downloadPng(canvas) {
        if (!canvas) return;
        var url = '';
        try { url = canvas.toDataURL('image/png'); } catch (e) { return; }
        if (!url) return;
        var a = document.createElement('a');
        a.href = url;
        a.download = '气象简报机场预警截图_' + formatTimestamp() + '.png';
        document.body.appendChild(a);
        a.click();
        // 延迟移除，避免某些浏览器（Safari）在 click 后立即移除导致下载失败
        setTimeout(function () {
            try { document.body.removeChild(a); } catch (e) { /* ignore */ }
        }, 200);
    }

    /**
     * 格式化时间戳（用于下载文件名）
     * @returns {string}
     */
    function formatTimestamp() {
        var d = new Date();
        var pad = function (n) { return n < 10 ? '0' + n : '' + n; };
        return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) +
            '_' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
    }

    /**
     * 绑定弹窗事件（仅执行一次）
     */
    function bindModalEvents() {
        if (escListenerBound) return;
        escListenerBound = true;
        if (typeof document === 'undefined') return;
        // 全局 ESC 关闭
        document.addEventListener('keydown', function (e) {
            if (!modalElements || !modalElements.modal) return;
            if (modalElements.modal.hidden) return;
            if (e && e.key === 'Escape') {
                e.preventDefault();
                closeModal();
            }
        });
    }

    /**
     * 显示预览弹窗
     *   - 渲染 canvas 到 img
     *   - 绑定一次性事件
     *   - 不负责复制剪贴板，由 handleButtonClick 协调
     * @param {HTMLCanvasElement} canvas
     * @returns {{ close: function, download: function, showToast: function }}
     */
    function showPreview(canvas) {
        ensureModalElements();
        bindModalEvents();
        if (!modalElements.modal) {
            if (global.Logger) global.Logger.warn('截图弹窗 DOM 未找到，无法预览');
            return { close: function () {}, download: function () {}, showToast: function () {} };
        }
        // 渲染图片
        if (modalElements.img && canvas) {
            try {
                modalElements.img.src = canvas.toDataURL('image/png');
            } catch (e) {
                if (global.Logger) global.Logger.warn('img 渲染失败：' + (e && e.message));
            }
        }
        // 显示弹窗
        modalElements.modal.hidden = false;
        modalElements.modal.setAttribute('aria-hidden', 'false');

        // 关闭按钮
        if (modalElements.close && !modalElements.close._screenshotBound) {
            modalElements.close._screenshotBound = true;
            modalElements.close.addEventListener('click', closeModal);
        }
        // 确认按钮（关闭）
        if (modalElements.confirm && !modalElements.confirm._screenshotBound) {
            modalElements.confirm._screenshotBound = true;
            modalElements.confirm.addEventListener('click', closeModal);
        }
        // 下载按钮
        if (modalElements.download && !modalElements.download._screenshotBound) {
            modalElements.download._screenshotBound = true;
            modalElements.download.addEventListener('click', function () { downloadPng(canvas); });
        }
        // 遮罩点击
        if (modalElements.backdrop && !modalElements.backdrop._screenshotBound) {
            modalElements.backdrop._screenshotBound = true;
            modalElements.backdrop.addEventListener('click', closeModal);
        }

        return {
            close: closeModal,
            download: function () { downloadPng(canvas); },
            showToast: showToast
        };
    }

    /**
     * 按钮点击入口：从 NextDayRiskModule 取数据 → 生成 → 预览 → 自动复制
     */
    function handleButtonClick() {
        if (typeof document === 'undefined' || !document.getElementById) {
            // Node.js 环境跳过
            return;
        }
        var risks = [];
        if (global.NextDayRiskModule && typeof global.NextDayRiskModule.getRisks === 'function') {
            try { risks = global.NextDayRiskModule.getRisks() || []; } catch (e) { risks = []; }
        }
        if (!Array.isArray(risks) || risks.length === 0) {
            if (global.Logger) global.Logger.warn('截图生成：当前已录入风险为空');
            return;
        }
        generate(risks).then(function (result) {
            var ctx = showPreview(result.canvas);
            if (!ctx) return;
            // 尝试复制到剪贴板
            copyToClipboard(result.blob).then(function () {
                if (global.Logger) global.Logger.info('截图已复制到剪贴板');
                ctx.showToast('已复制到剪贴板', 'success');
            }).catch(function (err) {
                if (global.Logger) global.Logger.warn('剪贴板复制失败：' + (err && err.message));
                ctx.showToast('请手动下载（剪贴板权限被拒绝）', 'warn');
            });
        }).catch(function (err) {
            if (global.Logger) global.Logger.error('截图生成失败：' + (err && err.message));
        });
    }

    /* ============================================================
     * 暴露 API
     * ============================================================ */
    global.AirportWarningScreenshot = {
        handleButtonClick: handleButtonClick,
        generate: generate,
        copyToClipboard: copyToClipboard,
        showPreview: showPreview,
        _drawTableToCanvas: _drawTableToCanvas,
        _buildDomesticRows: _buildDomesticRows,
        _buildForeignRows: _buildForeignRows,
        _formatTimeForScreenshot: _formatTimeForScreenshot,
        // 暴露辅助函数（便于单测与扩展）
        _computeCanvasHeight: computeCanvasHeight,
        _drawLevelColumn: drawLevelColumn,
        _drawCell: drawCell,
        _groupByLevel: groupByLevel,
        _computeRowHeight: computeRowHeight,
        _computeWrappedLines: computeWrappedLines,
        _LEVEL_INFO: LEVEL_INFO,
        _COL_WIDTHS: COL_WIDTHS,
        _ROW_HEIGHT: ROW_HEIGHT,
        _CANVAS_WIDTH: CANVAS_WIDTH,
        _SCALE: SCALE,
        _BORDER_LINE_WIDTH: BORDER_LINE_WIDTH
    };
})(typeof window !== 'undefined' ? window : this);
