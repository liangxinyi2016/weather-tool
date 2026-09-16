/**
 * 「大风/沙尘/结冰天气发布」模块
 * - 接收用户在 textarea 中输入的 TAF 文本（支持多机场 〖XXX〗 标记，自动跳过 METAR/SPECI）
 * - 调用 TafParser 解析并按自定义规则识别大风/沙尘/结冰
 * - 在页面实时预览与导出 PDF 完全一致的"大风/沙尘/结冰条件天气监控通报"表格
 * - 一键导出 PDF 通报（浏览器打印 → 另存为 PDF）
 * - 监听规则变更事件，立即对最近一次解析结果重算
 */
(function (global) {
    'use strict';

    var STORAGE_KEY_LAST_TAF = 'met_tool_last_taf';
    var STORAGE_KEY_LAST_RESULT = 'met_tool_last_taf_result';
    // 持久化用户在预览表格上的手动修改：{ "行号_列号": "新值" }
    var STORAGE_KEY_OVERRIDES = 'met_tool_taf_overrides';
    // 制作人姓名（独立持久化，编辑后立即落盘）
    var STORAGE_KEY_PUBLISHER = 'met_tool_publisher';
    // 发布时间（独立持久化，编辑后立即落盘；为空时使用当前北京时间）
    var STORAGE_KEY_PUBLISH_TIME = 'met_tool_publish_time';
    // 用户对"展开全部"的选择
    var STORAGE_KEY_SHOW_ALL = 'met_tool_show_all_rows';
    var PREVIEW_TITLE = '大风/沙尘/结冰条件天气监控通报';
    var PREVIEW_HEADERS = ['机场', '风速（米/秒）', '天气现象', '能见度（米）', '是否满足地面结冰条件'];
    var PUBLISHER_PREFIX = '制作人：';
    var PUBLISHER_PLACEHOLDER = '[点击输入姓名]';
    var PUBLISH_TIME_PREFIX = '发布时间：';
    var PUBLISH_TIME_PLACEHOLDER = '[点击输入发布时间]';

    var elements = {};
    var state = {
        lastParse: null,    // 最近一次 TafParser.parse 结果
        lastInput: '',      // 最近一次原始输入
        lastIdentified: null, // 最近一次 identifyWindDustIce 结果
        // 单元格覆盖值：key = "行号_列号"，value = 用户编辑后的字符串
        // 行结构（与 buildAoa 输出对齐）：
        //   - 行 0：标题
        //   - 行 1：制作人
        //   - 行 2：发布时间
        //   - 行 3：表头（不可编辑）
        //   - 行 4+：机场数据行（允许编辑全部 5 列）
        cellOverrides: {},
        publisher: '',
        publishTime: '',
        showAllRows: false,  // 默认折叠：只展示有变化的行
        rules: Object.assign({}, TafParser.DEFAULT_RULES)
    };

    /* ============================================================
     * 工具函数
     * ============================================================ */

    /**
     * 把 Date 格式化为北京时间字符串 YYYY-MM-DD HH:mm:ss
     * @param {Date} [d]
     * @returns {string}
     */
    function formatBeijingTime(d) {
        d = d || new Date();
        var utc = d.getTime() + (d.getTimezoneOffset() * 60000);
        var beijing = new Date(utc + 3600000 * 8);
        var pad = function (n) { return n < 10 ? '0' + n : '' + n; };
        return beijing.getFullYear() + '-' +
            pad(beijing.getMonth() + 1) + '-' +
            pad(beijing.getDate()) + ' ' +
            pad(beijing.getHours()) + ':' +
            pad(beijing.getMinutes()) + ':' +
            pad(beijing.getSeconds());
    }

    function escapeHtml(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    /**
     * 将单元格文本中的换行符转换为 <br>，其它特殊字符走 escapeHtml。
     * 单元格文本保留前后的空格（"无" 等占位不应被 trim）。
     */
    function cellHtml(value) {
        if (value === null || value === undefined) return '';
        var str = String(value);
        // 先转义全部 HTML，再把换行符替换为 <br>
        var escaped = escapeHtml(str);
        return escaped.replace(/\n/g, '<br>');
    }

    /**
     * 构造覆盖值的 key：行号 + "_" + 列号
     * - 行/列均为数字 0-based
     */
    function overrideKey(rowIdx, colIdx) {
        return rowIdx + '_' + colIdx;
    }

    /**
     * 浅拷贝覆盖对象（避免外部直接修改 state）
     */
    function cloneOverrides() {
        var out = {};
        Object.keys(state.cellOverrides).forEach(function (k) {
            out[k] = state.cellOverrides[k];
        });
        return out;
    }

    /**
     * 更新"未保存修改"徽标和保存/还原按钮的可用状态
     * - dirty 时显示徽标 + 启用按钮
     * - clean 时隐藏徽标 + 禁用按钮
     */
    function refreshEditActions() {
        var dirty = hasUnsavedEdits();
        var badge = elements.unsavedBadge;
        var saveBtn = elements.btnSaveEdits;
        var resetBtn = elements.btnResetEdits;
        if (badge) badge.hidden = !dirty;
        if (saveBtn) saveBtn.disabled = !dirty;
        if (resetBtn) resetBtn.disabled = !dirty;
    }

    /**
     * 判断当前是否有未保存的编辑
     * - 与持久化到 STORAGE_KEY_OVERRIDES 的快照对比
     * - 完全一致视为"已保存"
     */
    function hasUnsavedEdits() {
        var saved = Storage.get(STORAGE_KEY_OVERRIDES, {}) || {};
        var cur = state.cellOverrides || {};
        return !overridesEqual(saved, cur);
    }

    function overridesEqual(a, b) {
        var keysA = Object.keys(a || {});
        var keysB = Object.keys(b || {});
        if (keysA.length !== keysB.length) return false;
        for (var i = 0; i < keysA.length; i++) {
            var k = keysA[i];
            if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
            if (String(a[k]) !== String(b[k])) return false;
        }
        return true;
    }

    /* ============================================================
     * 通报预览渲染
     *   数据来源：XlsxExporter.buildAoa(parsed, identified, overrides, {publisher, publishTime})
     *   - 与导出 PDF 的 AOA 完全一致，确保页面所见 = 文件所得
     *   - 行结构：0 标题 / 1 制作人 / 2 发布时间 / 3 表头（单行） / 4+ 数据
     *   - 默认折叠：仅展示"有变化"或"被编辑"的行
     * ============================================================ */

    function renderExcelPreview(parsed, identified) {
        var body = elements.previewBody;
        var hint = elements.previewHint;
        if (!body) return;

        if (!parsed) {
            body.innerHTML = '<tr class="xlsx-empty">' +
                '<td colspan="5">尚未解析 TAF 报文。请在上方粘贴报文后点击"解析 TAF"，此处将实时展示将要导出的通报内容。</td>' +
                '</tr>';
            if (hint) hint.textContent = '解析 TAF 后将在此显示 63 机场通报模板';
            refreshEditActions();
            refreshToggleAll();
            return;
        }

        if (typeof XlsxExporter === 'undefined' || typeof XlsxExporter.buildAoa !== 'function') {
            body.innerHTML = '<tr class="xlsx-empty">' +
                '<td colspan="5">EXCEL 导出模块未加载，请确认 assets/js/wind-dust-ice/exporter-xlsx.js 已引入。</td>' +
                '</tr>';
            return;
        }

        var result = XlsxExporter.buildAoa(
            parsed, identified, state.cellOverrides,
            { publisher: state.publisher, publishTime: state.publishTime }
        );
        var aoa = result && result.aoa ? result.aoa : [];
        var hits = (result && result.hits) || [];
        // 超标单元格：与 Excel 导出保持一致，在预览中以红色字体高亮
        var redCells = (result && result.redCells) || {};

        var html = '';
        // 行 0：标题（合并 5 列）
        if (aoa.length > 0) {
            html += '<tr class="xlsx-title"><td colspan="5">' +
                escapeHtml(aoa[0][0] || PREVIEW_TITLE) + '</td></tr>';
        }
        // 行 1：制作人（合并 5 列，可编辑）
        if (aoa.length > 1) {
            html += '<tr class="xlsx-publisher-row"><td colspan="5" ' +
                'class="col-publisher" contenteditable="true" spellcheck="false" ' +
                'data-row="1" data-col="0" data-publisher="1">' +
                cellHtml(aoa[1][0]) + '</td></tr>';
        }
        // 行 2：发布时间（合并 5 列，可编辑）
        if (aoa.length > 2) {
            html += '<tr class="xlsx-time-row"><td colspan="5" ' +
                'class="col-time" contenteditable="true" spellcheck="false" ' +
                'data-row="2" data-col="0" data-publish-time="1">' +
                cellHtml(aoa[2][0]) + '</td></tr>';
        }
        // 行 3：表头（单行，5 列）
        if (aoa.length > 3) {
            html += '<tr class="xlsx-header-row">' +
                '<th class="col-airport">' + escapeHtml(aoa[3][0] || PREVIEW_HEADERS[0]) + '</th>' +
                '<th class="col-wind">' + escapeHtml(aoa[3][1] || PREVIEW_HEADERS[1]) + '</th>' +
                '<th class="col-phenomenon">' + escapeHtml(aoa[3][2] || PREVIEW_HEADERS[2]) + '</th>' +
                '<th class="col-vis">' + escapeHtml(aoa[3][3] || PREVIEW_HEADERS[3]) + '</th>' +
                '<th class="col-ice">' + escapeHtml(aoa[3][4] || PREVIEW_HEADERS[4]) + '</th>' +
                '</tr>';
        }

        // 行 4+：数据行
        var hitSet = {};
        hits.forEach(function (h) { hitSet[h.rowIdx] = h; });

        // 计算"有变化"的行集合
        // 1) 命中行（identify 出来的）：始终展示
        // 2) 被用户编辑过的行：始终展示
        // 3) 其它全"无"的行：仅在 showAllRows=true 时展示
        var showAll = !!state.showAllRows;
        var visibleRowIdxs = [];
        var hiddenCount = 0;
        for (var i = 4; i < aoa.length; i++) {
            if (shouldShowRow(i, aoa[i], hitSet[i])) {
                visibleRowIdxs.push(i);
            } else {
                hiddenCount++;
            }
        }
        if (showAll) {
            // 展开全部：所有行都显示
            visibleRowIdxs = [];
            for (var k = 4; k < aoa.length; k++) visibleRowIdxs.push(k);
            hiddenCount = 0;
        }

        visibleRowIdxs.forEach(function (i) {
            var row = aoa[i];
            var hit = hitSet[i];
            var cls = 'xlsx-row';
            if (hit) cls += hit.appended ? ' xlsx-row-appended' : ' xlsx-row-hit';
            html += '<tr class="' + cls + '">' +
                buildEditableTd(0, 'col-airport', i, row[0], hit, redCells) +
                buildEditableTd(1, 'col-wind', i, row[1], null, redCells) +
                buildEditableTd(2, 'col-phenomenon', i, row[2], null, redCells) +
                buildEditableTd(3, 'col-vis', i, row[3], null, redCells) +
                buildEditableTd(4, 'col-ice', i, row[4], null, redCells) +
                '</tr>';
        });

        // 底部"已隐藏 N 行"提示
        if (hiddenCount > 0) {
            html += '<tr class="xlsx-hidden-row"><td colspan="5">' +
                '已隐藏 ' + hiddenCount + ' 行无变化的机场。' +
                '<button type="button" class="btn small ghost" id="xlsx-expand-inline">展开全部</button>' +
                '</td></tr>';
        } else if (aoa.length > 4) {
            // 全部显示时，提示"已展开"
            html += '<tr class="xlsx-hidden-row"><td colspan="5">' +
                '已展开全部 ' + (aoa.length - 4) + ' 行。' +
                '<button type="button" class="btn small ghost" id="xlsx-collapse-inline">收起</button>' +
                '</td></tr>';
        }

        body.innerHTML = html;
        if (hint) {
            var hitCount = hits.length;
            hint.textContent = '命中 ' + hitCount + ' 个机场' +
                (hitCount > 0 ? '（高亮显示）' : '（请粘贴 TAF 报文）');
        }
        refreshEditActions();
        refreshToggleAll();
    }

    /**
     * 判断数据行是否应该展示
     * - 命中行（识别出大风/沙尘/结冰）：始终展示
     * - 被用户编辑过的行：始终展示
     * - 其它全"无"的行：折叠
     */
    function shouldShowRow(rowIdx, row, hit) {
        if (hit) return true;
        // 检查任意列是否被用户编辑
        for (var c = 0; c < 5; c++) {
            if (Object.prototype.hasOwnProperty.call(state.cellOverrides, overrideKey(rowIdx, c))) {
                return true;
            }
        }
        return false;
    }

    /**
     * 构造可编辑单元格 <td>
     * @param {number} colIdx 列号 0~4
     * @param {string} colClass 基础 CSS 类名（如 col-wind / col-ice）
     * @param {number} rowIdx 行号（与 buildAoa aoa 索引一致）
     * @param {string} value 单元格内容
     * @param {object} [hit] 命中行元数据（仅 A 列使用，渲染 ICAO 角标）
     * @param {Object} [redCells] 形如 { "行号_列号": true } 的超标单元格集合
     */
    function buildEditableTd(colIdx, colClass, rowIdx, value, hit, redCells) {
        var key = overrideKey(rowIdx, colIdx);
        var edited = Object.prototype.hasOwnProperty.call(state.cellOverrides, key);
        var cls = colClass + (edited ? ' xlsx-cell-edited' : '');
        // 超标单元格：添加 xlsx-cell-exceed 类（与 Excel 导出的红色字体一致）
        if (redCells && redCells[rowIdx + '_' + colIdx]) {
            cls += ' xlsx-cell-exceed';
        }
        var innerHtml = cellHtml(value);
        if (colIdx === 0 && hit && hit.icao) {
            innerHtml += '<span class="row-tag" contenteditable="false">' + escapeHtml(hit.icao) + '</span>';
        }
        return '<td class="' + cls + '" contenteditable="true" spellcheck="false" ' +
            'data-row="' + rowIdx + '" data-col="' + colIdx + '" ' +
            'data-key="' + escapeHtml(key) + '">' +
            innerHtml + '</td>';
    }

    /**
     * 切换"展开/收起全部"按钮的显示与文本
     */
    function refreshToggleAll() {
        var btn = elements.btnToggleAll;
        if (!btn) return;
        if (!state.lastParse) {
            btn.hidden = true;
            return;
        }
        btn.hidden = false;
        btn.textContent = state.showAllRows ? '收起全部' : '展开全部';
    }

    /**
     * 同步"未保存"状态到存储
     * - 不立即覆盖持久化内容，仅在用户主动"保存"时才落盘
     * - 但若当前 overrides 与持久化一致，则视为"已保存"状态
     */
    function markDirty() {
        refreshEditActions();
    }

    /* ============================================================
     * 解析与重算
     * ============================================================ */

    function parseCurrent() {
        var text = (elements.input.value || '').trim();
        elements.msg.hidden = true;
        if (!text) {
            showMsg('请粘贴 TAF 报文后再点击解析。', 'info');
            return;
        }
        try {
            var result = TafParser.parse(text);
            state.lastParse = result;
            state.lastInput = text;
            Storage.set(STORAGE_KEY_LAST_TAF, text);
            Storage.set(STORAGE_KEY_LAST_RESULT, result);

            if (result.isMultiAirport) {
                var airportCount = (result.airports || []).length;
                var ignored = result.ignored || 0;
                showMsg('多机场解析成功：共 ' + airportCount + ' 个机场' +
                    (ignored > 0 ? '，跳过更早 TAF ' + ignored + ' 份' : '') + '。', 'info');
            } else if (result.ignored > 0) {
                showMsg('已忽略 ' + result.ignored + ' 份更早报文，解析最新一份 ' + result.selected.icao + '。', 'info');
            } else {
                showMsg('解析成功：' + result.selected.icao + '（' + result.selected.validPeriod.raw + '）', 'info');
            }
            recompute();
            Logger.info('TAF 解析完成：isMultiAirport=' + !!result.isMultiAirport +
                ' / 机场数 ' + (result.airports || []).length +
                ' / 忽略 ' + (result.ignored || 0) + ' 份');
        } catch (e) {
            showMsg('解析失败：' + e.message, 'error');
            Logger.error('TAF 解析失败', e);
        }
    }

    function recompute() {
        if (!state.lastParse) {
            renderExcelPreview(null, null);
            return;
        }
        // 同步最新规则
        var rules = loadRules();
        var identified = TafParser.identifyWindDustIce(state.lastParse, rules);
        state.lastIdentified = identified;
        renderExcelPreview(state.lastParse, identified);
    }

    function showMsg(msg, type) {
        elements.msg.hidden = false;
        elements.msg.className = 'taf-msg ' + (type || 'info');
        elements.msg.textContent = msg;
    }

    /* ============================================================
     * 导出 PDF（直接生成，无需浏览器打印对话框）
     * ============================================================ */

    /**
     * 构建导出 PDF 的表格 HTML（所有机场，不跳过任何行）
     * @param {string[][]} aoa buildAoa 返回的二维数组
     * @param {Object} [options] { publisher, publishTime }
     * @returns {string} 完整的 HTML 字符串
     */
    function buildPdfTableHtml(aoa, options) {
        var title = (aoa[0] && aoa[0][0]) || '大风/沙尘/结冰条件天气监控通报';
        var publisher = (options && options.publisher) || '';
        var publishTime = (options && options.publishTime) || formatBeijingTime();
        var publisherDisplay = publisher ? '制作人：' + publisher : '制作人：[点击输入姓名]';
        var headers = ['机场', '风速（米/秒）', '天气现象', '能见度（米）', '是否满足地面结冰条件'];

        var rowsHtml = '';
        // 行 4+ 为数据行，全部渲染（不跳过任何行）
        for (var ri = 4; ri < aoa.length; ri++) {
            var row = aoa[ri] || [];
            rowsHtml += '<tr>' +
                '<td class="col-airport">' + escapeHtml(row[0] || '') + '</td>' +
                '<td>' + escapeHtml(stringifyCell(row[1])) + '</td>' +
                '<td>' + escapeHtml(stringifyCell(row[2])) + '</td>' +
                '<td>' + escapeHtml(stringifyCell(row[3])) + '</td>' +
                '<td>' + escapeHtml(stringifyCell(row[4])) + '</td>' +
                '</tr>\n';
        }

        // 固定列宽百分比（确保所有列在一页内）
        // A4 竖版有效宽度约 190mm，5 列分配：
        // 机场 10% / 风速 24% / 天气现象 22% / 能见度 20% / 结冰 24%
        var html = '<!DOCTYPE html>\n<html lang="zh-CN">\n<head>\n' +
            '<meta charset="UTF-8">\n' +
            '<style>\n' +
            'body { font-family: "Microsoft YaHei", "PingFang SC", "Helvetica Neue", Arial, sans-serif; ' +
                'margin: 0; padding: 0; color: #333; font-size: 12px; }\n' +
            '.table-wrap { width: 800px; margin: 0 auto; }\n' +
            '.title { font-size: 18px; font-weight: bold; text-align: center; ' +
                'padding: 8px 0 4px 0; }\n' +
            '.meta { font-size: 12px; text-align: center; padding: 2px 8px; ' +
                'display: flex; justify-content: space-between; ' +
                'border-bottom: 1px solid #333; margin-bottom: 4px; }\n' +
            '.meta-left { text-align: left; }\n' +
            '.meta-right { text-align: right; }\n' +
            'table { width: 100%; border-collapse: collapse; font-size: 11px; ' +
                'table-layout: fixed; }\n' +
            'th, td { border: 1px solid #555; padding: 3px 4px; ' +
                'text-align: center; vertical-align: middle; word-wrap: break-word; ' +
                'overflow: hidden; }\n' +
            'th { background: #d9d9d9; font-weight: 600; }\n' +
            'td.col-airport { font-weight: 500; }\n' +
            // 列宽分配（竖版，5 列）
            'th:nth-child(1), td:nth-child(1) { width: 10%; }\n' +
            'th:nth-child(2), td:nth-child(2) { width: 24%; }\n' +
            'th:nth-child(3), td:nth-child(3) { width: 22%; }\n' +
            'th:nth-child(4), td:nth-child(4) { width: 20%; }\n' +
            'th:nth-child(5), td:nth-child(5) { width: 24%; }\n' +
            'td { white-space: pre-wrap; }\n' +
            '</style>\n</head>\n<body>\n' +
            '<div class="table-wrap">\n' +
            '<div class="title">' + escapeHtml(title) + '</div>\n' +
            '<div class="meta">' +
            '<span class="meta-left">' + escapeHtml(publisherDisplay) + '</span>' +
            '<span class="meta-right">发布时间：' + escapeHtml(publishTime) + '</span>' +
            '</div>\n' +
            '<table>\n' +
            '<thead>\n<tr>' +
            '<th>' + escapeHtml(headers[0]) + '</th>' +
            '<th>' + escapeHtml(headers[1]) + '</th>' +
            '<th>' + escapeHtml(headers[2]) + '</th>' +
            '<th>' + escapeHtml(headers[3]) + '</th>' +
            '<th>' + escapeHtml(headers[4]) + '</th>' +
            '</tr>\n</thead>\n<tbody>\n' +
            rowsHtml +
            '</tbody>\n</table>\n' +
            '<div style="text-align:right; font-size:9px; margin-top:4px; color:#888;">' +
            '共 ' + (aoa.length - 4) + ' 个机场' +
            '</div>\n' +
            '</div>\n</body>\n</html>';
        return html;
    }

    /** 将 null/undefined 转为空串，避免 "null" 字样 */
    function stringifyCell(v) {
        return (v == null) ? '' : String(v);
    }

    /**
     * 直接导出 PDF 文件（使用 html2canvas + jsPDF）
     * - 竖版 A4，所有列在一页内
     * - 所有机场全部显示（不分页过滤）
     * - 直接触发文件下载，不调用浏览器打印对话框
     */
    function exportPdf() {
        if (!state.lastParse) {
            showMsg('请先解析 TAF 报文。', 'info');
            return;
        }
        if (typeof XlsxExporter === 'undefined' || typeof XlsxExporter.buildAoa !== 'function') {
            showMsg('通报模块未加载，请检查 airports.js / exporter-xlsx.js 是否引入。', 'error');
            if (global.Logger) Logger.error('XlsxExporter 未定义');
            return;
        }
        // 检查 jsPDF 是否加载
        if (typeof jspdf === 'undefined' && typeof window.jspdf === 'undefined') {
            showMsg('jsPDF 库未加载，请确认 assets/vendor/jspdf.umd.min.js 已引入。', 'error');
            return;
        }
        var rules = loadRules();
        var identified = TafParser.identifyWindDustIce(state.lastParse, rules);
        state.lastIdentified = identified;
        var overrides = cloneOverrides();
        var finalPublisher = state.publisher;
        if (!finalPublisher && global.UserIdentity && typeof global.UserIdentity.get === 'function') {
            try {
                var syncName = global.UserIdentity.get();
                if (syncName) {
                    finalPublisher = syncName;
                    state.publisher = syncName;
                    Storage.set(STORAGE_KEY_PUBLISHER, syncName);
                }
            } catch (e) { /* ignore */ }
        }
        var finalPublishTime = state.publishTime || formatBeijingTime();
        var built = XlsxExporter.buildAoa(state.lastParse, identified, overrides, {
            publisher: finalPublisher,
            publishTime: finalPublishTime
        });
        var aoa = built && built.aoa;
        if (!aoa || aoa.length < 4) {
            showMsg('无数据可导出。', 'error');
            return;
        }

        // 计算每页可容纳的行数
        var totalDataRows = aoa.length - 4; // 去除标题/制作人/时间/表头
        var HEADER_ROWS = 4; // 标题+制作人+时间+表头

        // 强制分为2页显示
        var targetPages = 2;
        var ROWS_PER_PAGE = Math.ceil(totalDataRows / targetPages);
        var pageCount = targetPages;

        // 生成单页 HTML 模板（共用）
        var headerHtml = buildPdfHeaderHtml(aoa, { publisher: finalPublisher, publishTime: finalPublishTime });

        // 并发渲染每一页的 canvas
        var pageCanvases = [];
        var tasks = [];

        for (var p = 0; p < pageCount; p++) {
            var startRow = p * ROWS_PER_PAGE;
            var endRow = Math.min(startRow + ROWS_PER_PAGE, totalDataRows);
            var rowsHtml = buildPdfRowsHtml(aoa, startRow + HEADER_ROWS, endRow + HEADER_ROWS);
            var pageHtml = '<!DOCTYPE html>\n<html lang="zh-CN">\n<head>\n' +
                '<meta charset="UTF-8">\n' +
                '<style>\n' +
                'body { font-family: "Microsoft YaHei", "PingFang SC", "Helvetica Neue", Arial, sans-serif; ' +
                    'margin: 0; padding: 0; color: #333; font-size: 12px; }\n' +
                '.table-wrap { width: 800px; margin: 0 auto; }\n' +
                '.title { font-size: 18px; font-weight: bold; text-align: center; ' +
                    'padding: 8px 0 4px 0; }\n' +
                '.meta { font-size: 12px; text-align: center; padding: 2px 8px; ' +
                    'display: flex; justify-content: space-between; ' +
                    'border-bottom: 1px solid #333; margin-bottom: 4px; }\n' +
                '.meta-left { text-align: left; }\n' +
                '.meta-right { text-align: right; }\n' +
                'table { width: 100%; border-collapse: collapse; font-size: 11px; ' +
                    'table-layout: fixed; }\n' +
                'th, td { border: 1px solid #555; padding: 3px 4px; ' +
                    'text-align: center; vertical-align: middle; word-wrap: break-word; ' +
                    'overflow: hidden; }\n' +
                'th { background: #d9d9d9; font-weight: 600; }\n' +
                'td.col-airport { font-weight: 500; }\n' +
                'th:nth-child(1), td:nth-child(1) { width: 10%; }\n' +
                'th:nth-child(2), td:nth-child(2) { width: 24%; }\n' +
                'th:nth-child(3), td:nth-child(3) { width: 22%; }\n' +
                'th:nth-child(4), td:nth-child(4) { width: 20%; }\n' +
                'th:nth-child(5), td:nth-child(5) { width: 24%; }\n' +
                'td { white-space: pre-wrap; }\n' +
                '</style>\n</head>\n<body>\n' +
                '<div class="table-wrap">\n' +
                headerHtml +
                rowsHtml +
                '</div>\n</body>\n</html>';

            tasks.push(renderPageToCanvas(pageHtml, p));
        }

        showMsg('正在生成 PDF（共 ' + pageCount + ' 页）...', 'info');

        Promise.all(tasks).then(function (results) {
            var pdf = new jspdf.jsPDF({
                orientation: 'portrait',
                unit: 'mm',
                format: 'a4'
            });

            var pdfWidth = pdf.internal.pageSize.getWidth();
            var pdfHeight = pdf.internal.pageSize.getHeight();
            var margin = 8;
            var usableWidth = pdfWidth - margin * 2;

            for (var r = 0; r < results.length; r++) {
                if (r > 0) pdf.addPage();
                var canvas = results[r];
                var imgData = canvas.toDataURL('image/jpeg', 0.92);
                var imgHeight = (canvas.height / canvas.width) * usableWidth;
                pdf.addImage(imgData, 'JPEG', margin, margin, usableWidth, imgHeight);
            }

            // 生成文件名
            var now = new Date();
            var pad = function (n) { return n < 10 ? '0' + n : '' + n; };
            var dateStr = now.getFullYear() + pad(now.getMonth() + 1) + pad(now.getDate());
            var filename = '大风沙尘结冰天气监控通报_' + dateStr + '.pdf';

            // 直接下载
            pdf.save(filename);

            var editHint = Object.keys(overrides).length > 0
                ? '（含 ' + Object.keys(overrides).length + ' 处手动修改）'
                : '';
            showMsg('PDF 已导出：' + filename + ' ' + editHint, 'info');
            if (global.Logger) Logger.info('PDF 导出成功：' + filename + ' ' + (aoa.length - 4) + ' 个机场，' + pageCount + ' 页');
        }).catch(function (err) {
            showMsg('PDF 生成失败：' + (err.message || err), 'error');
            if (global.Logger) Logger.error('PDF 导出失败：', err);
        });
    }

    /**
     * 把单页 HTML 渲染为 canvas
     * @param {string} html 页面 HTML
     * @param {number} pageIndex 页码（仅用于日志）
     * @returns {Promise<HTMLCanvasElement>}
     */
    function renderPageToCanvas(html, pageIndex) {
        return new Promise(function (resolve, reject) {
            var container = document.createElement('div');
            container.style.cssText = 'position:fixed; left:-9999px; top:0; z-index:-1; ' +
                'background:#fff; width:800px;';
            container.innerHTML = html;
            document.body.appendChild(container);

            html2canvas(container, {
                scale: 3,
                useCORS: true,
                backgroundColor: '#ffffff',
                logging: false,
                width: 800,
                onclone: function () {}
            }).then(function (canvas) {
                document.body.removeChild(container);
                resolve(canvas);
            }).catch(function (err) {
                document.body.removeChild(container);
                reject(err);
            });
        });
    }

    /**
     * 构建 PDF 表头（标题 + 制作人 + 发布时间 + 列头）
     * @param {Array} aoa 完整 AOA 数组
     * @param {Object} options
     * @returns {string} HTML 字符串
     */
    function buildPdfHeaderHtml(aoa, options) {
        var title = (aoa[0] && aoa[0][0]) || '大风/沙尘/结冰条件天气监控通报';
        var publisher = (options && options.publisher) || '';
        var publishTime = (options && options.publishTime) || '';
        var publisherDisplay = publisher ? '制作人：' + publisher : '制作人：[点击输入姓名]';
        var headers = ['机场', '风速（米/秒）', '天气现象', '能见度（米）', '是否满足地面结冰条件'];

        return '<div class="title">' + escapeHtml(title) + '</div>\n' +
            '<div class="meta">' +
            '<span class="meta-left">' + escapeHtml(publisherDisplay) + '</span>' +
            '<span class="meta-right">发布时间：' + escapeHtml(publishTime) + '</span>' +
            '</div>\n' +
            '<table>\n' +
            '<thead>\n<tr>' +
            '<th>' + escapeHtml(headers[0]) + '</th>' +
            '<th>' + escapeHtml(headers[1]) + '</th>' +
            '<th>' + escapeHtml(headers[2]) + '</th>' +
            '<th>' + escapeHtml(headers[3]) + '</th>' +
            '<th>' + escapeHtml(headers[4]) + '</th>' +
            '</tr>\n</thead>\n<tbody>\n';
    }

    /**
     * 构建 PDF 数据行 HTML（指定行范围）
     * @param {Array} aoa 完整 AOA
     * @param {number} startIdx 起始索引（含）
     * @param {number} endIdx 结束索引（不含）
     * @returns {string} HTML 字符串
     */
    function buildPdfRowsHtml(aoa, startIdx, endIdx) {
        var rowsHtml = '';
        for (var ri = startIdx; ri < endIdx && ri < aoa.length; ri++) {
            var row = aoa[ri] || [];
            rowsHtml += '<tr>' +
                '<td class="col-airport">' + escapeHtml(row[0] || '') + '</td>' +
                '<td>' + escapeHtml(stringifyCell(row[1])) + '</td>' +
                '<td>' + escapeHtml(stringifyCell(row[2])) + '</td>' +
                '<td>' + escapeHtml(stringifyCell(row[3])) + '</td>' +
                '<td>' + escapeHtml(stringifyCell(row[4])) + '</td>' +
                '</tr>\n';
        }
        return rowsHtml + '</tbody>\n</table>';
    }

    /* ============================================================
     * 保存 / 还原用户编辑
     * ============================================================ */

    /**
     * 把当前 cellOverrides 持久化到 chrome.storage.local
     */
    function saveEdits() {
        try {
            var snapshot = cloneOverrides();
            Storage.set(STORAGE_KEY_OVERRIDES, snapshot);
            Logger.info('已保存 ' + Object.keys(snapshot).length + ' 处单元格修改');
            showMsg('已保存 ' + Object.keys(snapshot).length + ' 处单元格修改。', 'info');
            refreshEditActions();
        } catch (e) {
            Logger.error('保存编辑失败', e);
            showMsg('保存失败：' + (e && e.message), 'error');
        }
    }

    /**
     * 清空当前 cellOverrides 并重新渲染（恢复到 TAF 解析的原始结果）
     */
    function resetEdits() {
        if (Object.keys(state.cellOverrides).length === 0) {
            refreshEditActions();
            return;
        }
        var ok = global.confirm('确定要还原所有手动修改吗？\n将恢复 TAF 解析的原始结果（已保存的修改也会被清除）。');
        if (!ok) return;
        state.cellOverrides = {};
        Storage.remove(STORAGE_KEY_OVERRIDES);
        Logger.info('已还原所有单元格修改');
        showMsg('已还原所有手动修改。', 'info');
        recompute();
    }

    /**
     * 清空所有 overrides（"清空"按钮 / 重新解析时调用）
     * - 不弹确认框
     */
    function clearEditsSilently() {
        state.cellOverrides = {};
        Storage.remove(STORAGE_KEY_OVERRIDES);
        refreshEditActions();
    }

    /* ============================================================
     * 单元格编辑事件（事件委托）
     * ============================================================ */

    /**
     * 处理 contenteditable 单元格的输入事件
     * - 通过 data-row / data-col 定位 cellOverrides key
     * - 输入即更新 state.cellOverrides，并打"未保存"标记
     * - 视觉上：给当前 td 加 xlsx-cell-edited 类（实时）
     * - 制作人行（data-publisher="1"）特殊处理：直接更新 state.publisher
     * - 发布时间行（data-publish-time="1"）特殊处理：直接更新 state.publishTime
     *
     * 注意：每次渲染都会重建 tbody，所以使用 tbody 事件委托，无需重新绑定
     */
    function onCellInput(e) {
        var td = e.target;
        if (!td || !td.dataset) return;
        if (!Object.prototype.hasOwnProperty.call(td.dataset, 'row')) return;
        // 制作人行：直接走 publisher 通道，立即持久化
        if (td.dataset.publisher === '1') {
            var raw = td.innerText || td.textContent || '';
            var name = String(raw).replace(/\r\n?/g, '\n').replace(/^[\s\u3000]+|[\s\u3000]+$/g, '');
            // 去掉"制作人："前缀再存
            if (name.indexOf(PUBLISHER_PREFIX) === 0) {
                name = name.substring(PUBLISHER_PREFIX.length);
            }
            state.publisher = name;
            Storage.set(STORAGE_KEY_PUBLISHER, name);
            // 制作人行不显示"未保存"徽标（独立通道）
            return;
        }
        // 发布时间行：直接走 publishTime 通道，立即持久化
        if (td.dataset.publishTime === '1') {
            var rawTime = td.innerText || td.textContent || '';
            var time = String(rawTime).replace(/\r\n?/g, '\n').replace(/^[\s\u3000]+|[\s\u3000]+$/g, '');
            if (time.indexOf(PUBLISH_TIME_PREFIX) === 0) {
                time = time.substring(PUBLISH_TIME_PREFIX.length);
            }
            state.publishTime = time;
            Storage.set(STORAGE_KEY_PUBLISH_TIME, time);
            return;
        }
        var rowIdx = parseInt(td.dataset.row, 10);
        var colIdx = parseInt(td.dataset.col, 10);
        if (!isFinite(rowIdx) || !isFinite(colIdx)) return;
        // contenteditable 文本中的 <br> 还原为换行符
        var raw = td.innerText || td.textContent || '';
        var value = String(raw).replace(/\r\n?/g, '\n');
        var key = overrideKey(rowIdx, colIdx);
        if (value === '' || value === null) {
            if (Object.prototype.hasOwnProperty.call(state.cellOverrides, key)) {
                delete state.cellOverrides[key];
            }
        } else {
            state.cellOverrides[key] = value;
        }
        td.classList.add('xlsx-cell-edited');
        refreshEditActions();
    }

    /**
     * 处理单元格失焦事件：清理 <br> 等浏览器自动产生的标签
     * - 重新计算 innerText 并写回 innerHTML，确保一致性
     */
    function onCellBlur(e) {
        var td = e.target;
        if (!td || !td.dataset) return;
        if (!Object.prototype.hasOwnProperty.call(td.dataset, 'row')) return;
        // 制作人行 / 发布时间行：不需要做额外处理
        if (td.dataset.publisher === '1') return;
        if (td.dataset.publishTime === '1') return;

        // 如果含 .row-tag（机场列的 ICAO 标签），保留 span 结构
        var tagEl = td.querySelector && td.querySelector('.row-tag');
        if (tagEl) {
            // 只更新文本节点，保留 span 不变
            var text = '';
            Array.prototype.forEach.call(td.childNodes, function (n) {
                if (n !== tagEl) {
                    if (n.nodeType === 3) text += n.nodeValue || '';
                    else if (n.nodeType === 1) text += n.innerText || n.textContent || '';
                }
            });
            text = String(text).replace(/\r\n?/g, '\n').replace(/\n+$/, '');
            // 重建子节点：文本 + span
            td.innerHTML = escapeHtml(text).replace(/\n/g, '<br>') +
                '<span class="row-tag" contenteditable="false">' + escapeHtml(tagEl.textContent) + '</span>';
            return;
        }

        // 普通单元格：清理 <br>、<div> 等浏览器自动产生的标签
        var text = td.innerText || td.textContent || '';
        text = String(text).replace(/\r\n?/g, '\n').replace(/\n+$/, '');
        td.innerHTML = escapeHtml(text).replace(/\n/g, '<br>');
    }

    /**
     * 处理单元格 Enter 键：避免插入 <div>，改为失焦
     */
    function onCellKeydown(e) {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            e.target.blur();
        }
    }

    /**
     * 切换"展开/收起全部"
     * - 状态持久化到 STORAGE_KEY_SHOW_ALL
     */
    function toggleShowAllRows() {
        state.showAllRows = !state.showAllRows;
        Storage.set(STORAGE_KEY_SHOW_ALL, state.showAllRows);
        recompute();
    }

    /**
     * 处理底部"已隐藏 N 行"行内的"展开全部"按钮
     * 事件委托到 tbody
     */
    function onPreviewClick(e) {
        var t = e.target;
        if (!t || !t.id) return;
        if (t.id === 'xlsx-expand-inline' || t.id === 'xlsx-collapse-inline') {
            toggleShowAllRows();
        }
    }

    /* ============================================================
     * 规则
     * ============================================================ */

    function loadRules() {
        var stored = Storage.get('met_tool_rules', null);
        if (stored) {
            state.rules = Object.assign({}, TafParser.DEFAULT_RULES, stored);
        }
        return state.rules;
    }

    /* ============================================================
     * 示例
     * ============================================================ */

    /**
     * 多组示例，每次点击"填入示例"按钮循环切换，便于验证
     * 单机场 KT（国际报文）/ MPS（国产报文）/ CAVOK（能见度极好，跳过沙尘）/ VRB（多变风）
     * 静风 / 多机场（〖XXX〗 标记，自动跳过 METAR）
     */
    var SAMPLES = [
        {
            label: 'KT（国际报文）',
            text: 'TAF ZPPP 120300Z 1206/1312 25015G25KT 3000 SA ' +
                  'SCT040 BKN100 TX20/1207Z TN05/1212Z ' +
                  'TEMPO 1208/1212 2000 SA ' +
                  'BECMG 1218/1220 26008KT'
        },
        {
            label: 'MPS（国产报文）',
            text: 'TAF ZBAD 150310Z 1506/1606 18004MPS 4000 -SHRA BKN020 ' +
                  'TX10/1506Z TNM08/1522Z ' +
                  'BECMG 1506/1512 36010G15MPS 8000 ' +
                  'TEMPO 1512/1518 2000 SA'
        },
        {
            label: 'CAVOK（能见度极好）',
            text: 'TAF ZBAA 120600Z 1206/1306 09005MPS CAVOK ' +
                  'TX25/1207Z TN10/1222Z ' +
                  'BECMG 1212/1214 18010G15MPS'
        },
        {
            // CAVOK 主组跳过沙尘；BECMG（1500 SA）与 TEMPO（2000 SS）均能命中。
            // 用于人工核验：CAVOK 跳过 + 沙尘变化组正常识别。
            label: 'CAVOK + 沙尘变化组',
            text: 'TAF ZBAA 120600Z 1206/1306 09005MPS CAVOK ' +
                  'TX25/1207Z TN10/1222Z ' +
                  'BECMG 1212/1214 18010G15MPS 1500 SA ' +
                  'TEMPO 1218/1220 2000 SS'
        },
        {
            label: 'VRB（多变风）',
            text: 'TAF ZSPD 120300Z 1206/1312 VRB03MPS 9999 FEW030 ' +
                  'TX22/1207Z TN12/1222Z ' +
                  'TEMPO 1210/1214 VRB02MPS 3000 SA'
        },
        {
            label: '静风（00000MPS）',
            text: 'TAF ZHHH 120300Z 1206/1312 00000MPS 0800 FG ' +
                  'TX15/1207Z TN08/1222Z ' +
                  'BECMG 1212/1214 03003MPS 3000'
        },
        {
            label: '多机场（〖XXX〗 标记，跳过 METAR）',
            text: 'ZLXY〗\n' +
                  'METAR ZLXY 180400Z 35004MPS 320V020 CAVOK 33/16 Q1009 NOSIG=\n' +
                  'TAF ZLXY 180302Z 1806/1906 30004MPS 6000 NSC TX36/1906Z TN21/1821Z=\n' +
                  '〖ZLLL〗\n' +
                  'METAR ZLLL 180400Z 21004MPS 130V270 9999 FEW016 21/13 Q1021 NOSIG=\n' +
                  'TAF ZLLL 180300Z 1806/1906 20003MPS 6000 NSC TX26/1809Z TN12/1822Z TEMPO 1806/1810 SCT020 FEW033CB=\n' +
                  '〖ZLIC〗\n' +
                  'METAR ZLIC 180400Z 22007MPS CAVOK 28/13 Q1012 BECMG TL0530 33004MPS=\n' +
                  'TAF ZLIC 180308Z 1806/1906 35004MPS 8000 NSC TX30/1807Z TN19/1823Z=\n' +
                  '〖ZLZW〗\n' +
                  'METAR ZLZW 180400Z 29006G12MPS 260V330 CAVOK 30/11 Q1014 NOSIG=\n' +
                  'TAF ZLZW 180403Z 1806/1815 30006G11MPS 8000 NSC TX32/1808Z TN21/1815Z BECMG 1810/1812 20004MPS='
        }
    ];

    var sampleIndex = 0;

    function fillNextSample() {
        var sample = SAMPLES[sampleIndex % SAMPLES.length];
        sampleIndex += 1;
        elements.input.value = sample.text;
        showMsg('已填入示例：' + sample.label + '（点击"填入示例"可循环切换下一组）', 'info');
        Logger.info('填入示例 TAF：' + sample.label);
    }

    /* ============================================================
     * 事件
     * ============================================================ */

    function bind() {
        elements.btnParse.addEventListener('click', parseCurrent);
        elements.btnSample.addEventListener('click', fillNextSample);
        elements.btnClear.addEventListener('click', function () {
            elements.input.value = '';
            state.lastParse = null;
            state.lastIdentified = null;
            state.cellOverrides = {};
            state.publisher = '';
            elements.msg.hidden = true;
            renderExcelPreview(null, null);
            Storage.remove(STORAGE_KEY_LAST_TAF);
            Storage.remove(STORAGE_KEY_LAST_RESULT);
            Storage.remove(STORAGE_KEY_OVERRIDES);
            Storage.remove(STORAGE_KEY_PUBLISHER);
        });
        // 导出 PDF 通报
        if (elements.btnExportPdf) {
            elements.btnExportPdf.addEventListener('click', exportPdf);
        }
        // 保存 / 还原用户编辑
        if (elements.btnSaveEdits) {
            elements.btnSaveEdits.addEventListener('click', saveEdits);
        }
        if (elements.btnResetEdits) {
            elements.btnResetEdits.addEventListener('click', resetEdits);
        }
        // 展开 / 收起全部
        if (elements.btnToggleAll) {
            elements.btnToggleAll.addEventListener('click', toggleShowAllRows);
        }
        // 单元格编辑事件（事件委托到 tbody，渲染重建后无需重新绑定）
        if (elements.previewBody) {
            elements.previewBody.addEventListener('input', onCellInput);
            elements.previewBody.addEventListener('blur', onCellBlur, true);
            elements.previewBody.addEventListener('keydown', onCellKeydown);
            elements.previewBody.addEventListener('click', onPreviewClick);
        }

        // 监听规则变更（来自 next-day-risk.js）
        global.addEventListener('met:rules-changed', function (e) {
            state.rules = Object.assign({}, TafParser.DEFAULT_RULES, e.detail || {});
            Logger.info('检测到规则变更，重新识别大风/沙尘/结冰');
            recompute();
        });
    }

    function restore() {
        var last = Storage.get(STORAGE_KEY_LAST_TAF, '');
        var lastResult = Storage.get(STORAGE_KEY_LAST_RESULT, null);
        // 加载用户上次的编辑覆盖
        var savedOverrides = Storage.get(STORAGE_KEY_OVERRIDES, {}) || {};
        state.cellOverrides = savedOverrides && typeof savedOverrides === 'object' ? savedOverrides : {};
        // 加载制作人姓名：
        //   1) 优先使用本模块独立保存的（用户在预览表格上编辑过的）
        //   2) 空时尝试从 UserIdentity 模块拉取（统一身份）
        var savedPublisher = Storage.get(STORAGE_KEY_PUBLISHER, '') || '';
        if (savedPublisher) {
            state.publisher = savedPublisher;
        } else if (global.UserIdentity && typeof global.UserIdentity.get === 'function') {
            // UserIdentity.get() 同步返回字符串（非 Promise），直接读取即可
            var name = global.UserIdentity.get();
            if (!state.publisher && name) {
                state.publisher = name;
                Storage.set(STORAGE_KEY_PUBLISHER, name);
                if (state.lastParse) {
                    renderExcelPreview(state.lastParse, state.lastIdentified);
                }
                Logger.info('已从 UserIdentity 自动同步制作人：' + name);
            }
        }
        // 加载发布时间：
        //   1) 优先使用本模块独立保存的（用户在预览表格上编辑过的）
        //   2) 空时使用当前北京时间（导出时也会再次取最新值）
        state.publishTime = Storage.get(STORAGE_KEY_PUBLISH_TIME, '') || formatBeijingTime();
        // 加载"展开全部"状态
        state.showAllRows = !!Storage.get(STORAGE_KEY_SHOW_ALL, false);
        if (last) {
            elements.input.value = last;
            if (lastResult) {
                state.lastParse = lastResult;
                recompute();
            }
        } else {
            refreshEditActions();
            refreshToggleAll();
        }
    }

    function init() {
        elements.input = document.getElementById('taf-input');
        elements.btnParse = document.getElementById('taf-parse');
        elements.btnSample = document.getElementById('taf-sample');
        elements.btnClear = document.getElementById('taf-clear');
        elements.btnExportPdf = document.getElementById('taf-export-pdf');
        elements.btnSaveEdits = document.getElementById('xlsx-save-edits');
        elements.btnResetEdits = document.getElementById('xlsx-reset-edits');
        elements.btnToggleAll = document.getElementById('xlsx-toggle-all');
        elements.unsavedBadge = document.getElementById('unsaved-badge');
        elements.msg = document.getElementById('taf-msg');
        elements.previewBody = document.getElementById('xlsx-preview-body');
        elements.previewHint = document.getElementById('xlsx-preview-hint');
        loadRules();
        bind();
        restore();
        Logger.info('大风/沙尘/结冰天气发布模块已初始化');
    }

    global.WindDustModule = { init: init, recompute: recompute, _state: state };
})(window);
