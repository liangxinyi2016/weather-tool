/**
 * 「次日风险制作」 - 系统录入 Excel 导出
 * --------------------------------------------------------------------
 * 模板列（与气象台「次日风险系统录入.xlsx」一致）：
 *   关注等级 | 机场 | 天气类型 | 气象预报 | 影响开始时间 | 影响结束时间
 *
 * 关注等级文字：
 *   黄 → 黄色预警（一般关注）
 *   橙 → 橙色预警（中度关注）
 *   红 → 红色预警（高度关注）
 *
 * 样式：水平+垂直居中、表头加粗 11pt、全框线、行高 22
 * 文件名：次日风险系统录入<MM月DD日>.xlsx（次日日期）
 *
 * 依赖
 *   - XLSX: xlsx-js-style（assets/vendor/xlsx.bundle.js）
 *   - next-day-risk.js: NextDayRiskModule.getRisks()
 *   - logger.js:  Logger.info / warn / error
 *
 * 暴露：global.NextDayRiskExcel = { exportRisks }
 */
(function (global) {
    'use strict';

    /* ============================================================
     * 常量
     * ============================================================ */

    /** 与 next-day-risk.js 共享的持久化键名（不直接使用，仅做语义对齐） */
    var STORAGE_KEY = 'met_tool_next_day_risks_v2';

    /** 表头（6 列） */
    var HEADERS = [
        '关注等级',
        '机场',
        '天气类型',
        '气象预报',
        '影响开始时间',
        '影响结束时间'
    ];

    /** 关注等级 → Excel 文字 */
    var LEVEL_TEXT_MAP = {
        '黄': '黄色预警（一般关注）',
        '橙': '橙色预警（中度关注）',
        '红': '红色预警（高度关注）'
    };

    /** 文件名前缀（次日日期会拼到后缀） */
    var FILENAME_PREFIX = '次日风险系统录入';

    /* ============================================================
     * 工具函数
     * ============================================================ */

    /**
     * 补零
     * @param {number} n
     * @returns {string}
     */
    function pad2(n) { return n < 10 ? '0' + n : '' + n; }

    /**
     * 将 yyyy/m/d HH:mm:ss 形式的时间字符串转换为 yyyy/m/d HH:mm（去掉秒）
     * @param {string} s
     * @returns {string}
     */
    function formatTimeForExcel(s) {
        if (!s) return '';
        return String(s).replace(/(\d{1,2}:\d{2}):\d{2}/, '$1');
    }

    /**
     * 计算次日的 MM月DD日 标签
     * @param {Date} [d]
     * @returns {string} 例: "07月21日"
     */
    function getNextDayDateLabel(d) {
        if (!d) d = new Date();
        var next = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
        return pad2(next.getMonth() + 1) + '月' + pad2(next.getDate()) + '日';
    }

    /**
     * 从单条风险对象构造一行数据（6 元素数组）
     * @param {object} risk
     * @returns {string[]}
     */
    function buildRow(risk) {
        return [
            LEVEL_TEXT_MAP[risk.level] || risk.level || '',
            risk.icao || '',
            (risk.weatherTypes || []).join(','),
            risk.forecast || '',
            formatTimeForExcel(risk.startTime && risk.startTime.value),
            formatTimeForExcel(risk.endTime && risk.endTime.value)
        ];
    }

    /**
     * 应用单元格样式：水平+垂直居中、表头加粗 11pt、全框线、行高 22
     * 参考 warning-record-exporter.js 的 applyCellStyles 风格
     * @param {object} ws XLSX worksheet
     * @param {string[][]} aoa
     */
    function applyCellStyles(ws, aoa) {
        if (!ws || !aoa || !aoa.length) return;
        if (!global.XLSX) return;

        var range = global.XLSX.utils.decode_range(ws['!ref']);
        var border = { style: 'thin', color: { rgb: '000000' } };
        var fullBorder = { top: border, bottom: border, left: border, right: border };

        // 行高统一 22
        var rows = [];
        for (var R = 0; R <= range.e.r; R++) rows.push({ hpt: 22 });
        ws['!rows'] = rows;

        for (var rr = range.s.r; rr <= range.e.r; rr++) {
            for (var cc = range.s.c; cc <= range.e.c; cc++) {
                var addr = global.XLSX.utils.encode_cell({ r: rr, c: cc });
                var cell = ws[addr];
                if (!cell) continue;
                cell.s = {
                    font: { name: '宋体', sz: 11, bold: rr === 0 },
                    alignment: { horizontal: 'center', vertical: 'center', wrapText: true },
                    border: fullBorder
                };
            }
        }
    }

    /**
     * 生成 aoa 并触发下载
     * @param {string[][]} aoa
     * @param {string} filename
     */
    function writeAndDownload(aoa, filename) {
        if (typeof global.XLSX === 'undefined') {
            throw new Error('XLSX 库未加载');
        }
        var ws = global.XLSX.utils.aoa_to_sheet(aoa);
        // 列宽（与 HEADERS 一一对应，共 6 列）
        ws['!cols'] = [
            { wch: 20 },  // A 关注等级
            { wch: 10 },  // B 机场
            { wch: 24 },  // C 天气类型
            { wch: 50 },  // D 气象预报
            { wch: 18 },  // E 影响开始时间
            { wch: 18 }   // F 影响结束时间
        ];
        applyCellStyles(ws, aoa);

        var wb = global.XLSX.utils.book_new();
        global.XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
        // 优先使用 writeFile（处理下载），fallback 到 array 形式
        try {
            global.XLSX.writeFile(wb, filename);
        } catch (e) {
            // 某些环境下 writeFile 不可用，回退到 array + 手动下载
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
    }

    /**
     * 触发 Excel 导出
     * 入口：global.NextDayRiskModule.getRisks()
     */
    function exportRisks() {
        try {
            var risks = (global.NextDayRiskModule && typeof global.NextDayRiskModule.getRisks === 'function')
                ? global.NextDayRiskModule.getRisks()
                : [];
            if (!risks || risks.length === 0) {
                if (global.Logger) global.Logger.warn('次日风险列表为空，未导出 Excel');
                return;
            }
            var aoa = [HEADERS];
            risks.forEach(function (r) { aoa.push(buildRow(r)); });
            var filename = FILENAME_PREFIX + getNextDayDateLabel(new Date()) + '.xlsx';
            writeAndDownload(aoa, filename);
            if (global.Logger) {
                global.Logger.info('导出次日风险 Excel: ' + filename + '，共 ' + risks.length + ' 条');
            }
        } catch (e) {
            if (global.Logger) global.Logger.error('次日风险 Excel 导出失败', e && e.message);
        }
    }

    /* ============================================================
     * 暴露 API
     * ============================================================ */
    global.NextDayRiskExcel = {
        exportRisks: exportRisks,
        // 暴露内部函数便于测试
        _buildRow: buildRow,
        _formatTimeForExcel: formatTimeForExcel,
        _getNextDayDateLabel: getNextDayDateLabel
    };
})(typeof window !== 'undefined' ? window : this);
