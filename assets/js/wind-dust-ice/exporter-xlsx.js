/**
 * 大风/沙尘/结冰通报 数据构建与 EXCEL 导出（已弃用 EXCEL 导出，仅保留 buildAoa 供预览和 PDF 导出使用）
 * --------------------------------------------------------------------
 * 设计目标
 *   1. 复用"大风沙尘结冰条件天气监控通报"模板的 63 个机场顺序与表头
 *   2. 支持「单机场」与「多机场（〖XXX〗 标记）」两种解析结果
 *      - 单机场：仅在对应模板行/表尾追加 1 行
 *      - 多机场：在所有命中模板的机场行填入；未命中的机场追加到表尾
 *   3. 单元格统一样式：水平居中 + 垂直居中；标题 A1 字号 16；所有有内容单元格全框线
 *   4. 行高根据内容自动调整
 *   5. （已弃用）使用本地 xlsx-js-style（xlsx.bundle.js）生成 .xlsx 二进制
 *      现改为 PDF 导出（浏览器打印 → 另存为 PDF），保留 buildAoa 供预览和 PDF 构建使用
 *
 * 暴露对象：window.XlsxExporter
 *   - buildAoa(parsed, identified, overrides, options): 构建二维数组（供预览和 PDF 使用）
 *   - exportReport(parsed, identified, options): 保留但不推荐使用（原 EXCEL 下载）
 */
(function (global) {
    'use strict';

    /* ============================================================
     * 模板数据
     * ============================================================ */

    /**
     * 表头与机场列表（与原模板一致）
     * 行 0：A1 合并到 E1，标题
     * 行 1：A2 合并到 E2，制作人
     * 行 2：A3 合并到 E3，发布时间
     * 行 3：表头（5 列：机场 / 风速 / 天气现象 / 能见度 / 是否满足地面结冰条件）
     * 行 4~66：63 个机场
     */
    var TITLE = '大风/沙尘/结冰条件天气监控通报';
    var HEADERS = ['机场', '风速（米/秒）', '天气现象', '能见度（米）', '是否满足地面结冰条件'];

    /* ============================================================
     * 数据格式化
     * ============================================================ */

    /**
     * 把"预计发生时间段"格式化为模板里的多行字符串
     * @param {object} item identifyWindDustIce 返回的单条
     * @returns {string} 多行文本
     */
    function formatWindPeriod(item) {
        var lines = [];
        var w = item.wind || {};
        if (w.speedMs !== null && w.speedMs !== undefined) {
            lines.push('平均风' + Math.ceil(w.speedMs));
        }
        if (w.gustMs !== null && w.gustMs !== undefined) {
            lines.push('阵风' + Math.ceil(w.gustMs));
        }
        // 时段：item.period 形如 "D+0 06:00 ~ D+0 12:00" 转为 "0600-1200时"
        lines.push(formatSimplePeriod(item.period));
        return lines.filter(Boolean).join('\n');
    }

    /**
     * 把"发生时段"格式化为 HHMM-HHMM时 形式（用于沙尘/结冰）
     * @param {string} period
     * @returns {string} 简化时段字符串
     */
    function formatSimplePeriod(period) {
        if (!period) return '';
        var m = period.match(/(\d{2}):(\d{2})\s*~\s*(?:D\+\d+\s*)?(\d{2}):(\d{2})/);
        if (m) return m[1] + m[2] + '-' + m[3] + m[4] + '时';
        return period;
    }

    /**
     * 沙尘条目格式化（B 列时间段 + D 列能见度）
     * 现象描述已从 C 列迁出，由 phenomena 数组统一提供天气代码
     */
    function formatDustRow(item) {
        return {
            period: formatSimplePeriod(item.period),
            visibility: (item.minVisibility || '') + ' 米'
        };
    }

    /**
     * 结冰条目格式化：结冰主要影响 E 列（是否满足地面结冰条件），
     * B 列时段不重复追加（风速/沙尘已包含该信息）
     */
    function formatIceRow(item) {
        return {
            period: '',  // 结冰不重复追加时段，避免与风/沙尘行重复
            ice: '是'
        };
    }

    /**
     * 大风条目格式化（B 列时段/风速信息）
     * 现象描述（"大风"）已从 C 列迁出；C 列统一展示 TAF 自身的天气代码
     */
    function formatWindRow(item) {
        return {
            period: formatWindPeriod(item),
            ice: '无'
        };
    }

    /**
     * 沙尘代码 → 中文标签映射
     * - 顺序固定：扬沙(SA) → 沙暴(SS) → 尘暴(DS) → 浮尘(DU)
     * - 输入：dust 事件的 codes 数组（如 ['SA','SS']）
     * - 输出：['扬沙','沙暴']
     * - 不在白名单中的代码会被忽略
     * - 强度前缀（+/-, 如 +SA / -SS）已由 parser 剥离，此处只处理无前缀的 2 字母代码
     */
    var DUST_CODE_LABELS = {
        'SA': '扬沙',
        'SS': '沙暴',
        'DS': '尘暴',
        'DU': '浮尘'
    };
    var DUST_LABEL_ORDER = ['扬沙', '沙暴', '尘暴', '浮尘'];

    /**
     * 从 dust 事件的 codes 数组生成有序的中文标签数组
     * - 保证每次输出顺序稳定（按 DUST_LABEL_ORDER 排序，与 TAF 中出现顺序无关）
     * - 同一 TAF 含多个沙尘代码时，分别映射后用逗号拼接（如"扬沙,沙暴"）
     * @param {string[]} codes
     * @returns {string[]}
     */
    function mapDustCodesToLabels(codes) {
        if (!Array.isArray(codes) || codes.length === 0) return [];
        var present = {};
        codes.forEach(function (c) {
            var key = String(c || '').toUpperCase();
            if (DUST_CODE_LABELS[key]) present[key] = true;
        });
        return DUST_LABEL_ORDER.filter(function (label) {
            // 反查：找哪个代码对应此 label
            for (var code in DUST_CODE_LABELS) {
                if (DUST_CODE_LABELS[code] === label) {
                    return !!present[code];
                }
            }
            return false;
        });
    }

    /**
     * 把 identified 合并为单行：取每类第一条
     * @param {object} identified { wind: [], dust: [], ice: [], phenomena: [] }
     */
    function mergeIdentified(identified) {
        return {
            wind: (identified && identified.wind && identified.wind.length > 0) ? identified.wind[0] : null,
            dust: (identified && identified.dust && identified.dust.length > 0) ? identified.dust[0] : null,
            ice: (identified && identified.ice && identified.ice.length > 0) ? identified.ice[0] : null,
            // TAF 中全部天气现象代码（按出现顺序去重，原始大小写）
            // 当前实现不再直接用于"天气现象"列（已被白名单映射替代），保留以备调试/将来扩展
            phenomena: (identified && Array.isArray(identified.phenomena)) ? identified.phenomena : []
        };
    }

    /**
     * 把 identified 应用到一个 5 元素数组 [机场, B, C, D, E]（机场名已由调用方填入）
     * C 列（天气现象）严格按以下规则组装，使用英文逗号 "," 分隔：
     *   1. "大风"  — 仅当识别到 wind 事件时（平均风或阵风 ≥ 8 m/s）
     *   2. "扬沙" / "沙暴" / "尘暴" / "浮尘" — 仅当 dust 事件触发时
     *      - dust 事件由 parser 判定，已隐含"能见度 ≤ 2000m + 含对应沙尘代码"两个条件
     *      - 同一 TAF 含多个沙尘代码时，分别映射后依次拼接（如 "扬沙,沙暴"）
     *      - 顺序固定为 扬沙 → 沙暴 → 尘暴 → 浮尘
     *      - 强度前缀（+/-, 如 +SA / -SS）一律忽略
     * 其他所有 TAF 天气现象（SHRA / FG / SN / RASN / BR / TSRA / ...）一律不入此列
     * 大风/沙尘/结冰识别结果仍按各自负责的列填充：风速（B）/能见度（D）/结冰（E）
     * @param {string[]} row
     * @param {object} identified
     */
    function applyIdentifiedToRow(row, identified) {
        var merged = mergeIdentified(identified);
        var hasWind = !!merged.wind;
        var hasDust = !!merged.dust;
        if (merged.wind) {
            var w = formatWindRow(merged.wind);
            row[1] = w.period;
            // E 列默认填充"无"（模板约定：有内容的行 E 列不应为空）
            row[4] = w.ice;
        } else {
            row[1] = '无';
            row[4] = '无';
        }
        // C 列：组装"大风" + dust 事件代码映射标签，逗号分隔
        var phenomenaParts = [];
        if (hasWind) phenomenaParts.push('大风');
        if (hasDust) {
            var dustLabels = mapDustCodesToLabels(merged.dust.codes);
            dustLabels.forEach(function (label) { phenomenaParts.push(label); });
        }
        row[2] = phenomenaParts.length > 0 ? phenomenaParts.join(',') : '无';
        // D 列（能见度）：默认 "无"，仅在识别到沙尘事件时被覆盖
        //   注：dust 事件已要求能见度 ≤ 2000m，这里直接把识别出的能见度写到 D 列
        row[3] = '无';
        if (merged.dust) {
            var d = formatDustRow(merged.dust);
            row[1] = mergePeriod(row[1], d.period);
            row[3] = mergeVisibility(row[3], d.visibility);
        }
        if (merged.ice) {
            var i2 = formatIceRow(merged.ice);
            row[4] = i2.ice;
        }
    }

    function mergePeriod(a, b) {
        if (!a || a === '无') return b;
        if (!b || b === '') return a;
        // 去重：按行拆分，已存在的行不再追加
        var linesA = a.split('\n');
        var linesB = b.split('\n');
        var result = linesA.slice();
        for (var i = 0; i < linesB.length; i++) {
            if (result.indexOf(linesB[i]) < 0) result.push(linesB[i]);
        }
        return result.join('\n');
    }

    function mergeVisibility(a, b) {
        if (!a || a === '无') return b;
        if (!b) return a;
        return a + ' / ' + b;
    }

    /* ============================================================
     * 工作表构建
     * ============================================================ */

    /**
     * 制作人行的标签前缀（占位常量）
     */
    var PUBLISHER_PREFIX = '制作人：';
    var PUBLISH_TIME_PREFIX = '发布时间：';

    /**
     * 把 Date 对象格式化为北京时间（UTC+8）字符串：YYYY-MM-DD HH:mm:ss
     * @param {Date} [d] 不传则取当前时间
     * @returns {string}
     */
    function formatBeijingTime(d) {
        d = d || new Date();
        // 转换为 UTC，再加 8 小时
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

    /**
     * 超标判定规则（用于"红色字体"高亮）
     * --------------------------------------------------------------------
     * 与 applyIdentifiedToRow 写入的字段含义保持一致：
     *   - B 列（风速）：识别到 wind 事件 → 平均风/阵风 ≥ 8 m/s 视为超标
     *   - C 列（天气现象）：识别到 wind 或 dust 事件 → 出现"大风"或任意沙尘标签
     *   - D 列（能见度）：识别到 dust 事件 → 隐含能见度 ≤ 2000m
     *   - E 列（地面结冰）：值为"是" → 满足地面结冰条件
     * 用户通过 overrides 把单元格编辑为"是"时，也会被判定为超标
     */
    function isExceed(merged, row) {
        return {
            wind: !!(merged && merged.wind),
            phenomenon: !!(merged && (merged.wind || merged.dust)),
            visibility: !!(merged && merged.dust),
            ice: !!(row && String(row[4]) === '是')
        };
    }

    /**
     * 构建单元格数据（行 0~N+）
     * 行结构：
     *   行 0：标题（合并 5 列）
     *   行 1：制作人：xxx（合并 5 列）
     *   行 2：发布时间：xxx（合并 5 列）
     *   行 3：表头（机场 | 风速 | 天气现象 | 能见度 | 是否满足地面结冰条件）
     *   行 4~N：机场数据行
     *
     * @param {object} parsed TafParser.parse 返回的解析结果（支持单/多机场）
     * @param {object} identified TafParser.identifyWindDustIce 返回值
     *        - 单机场：{ wind, dust, ice }
     *        - 多机场：{ byIcao: { icao -> { wind, dust, ice } } }
     * @param {object} [overrides] 用户在预览表格上编辑后的覆盖值
     *        - 形如 { "行号_列号": "新值" }，例如 "5_1" 表示第 5 行第 1 列
     *        - 命中后将覆盖默认 aoa 中的单元格内容
     * @param {object} [options] { publisher?: string, publishTime?: string }
     *        publisher: 制作人姓名（会写入 aoa[1][0]）
     *        publishTime: 发布时间字符串（会写入 aoa[2][0]）；为空时使用当前北京时间
     * @returns {{aoa: string[][], hits: Array<{icao, rowIdx, name, appended}>, redCells: Object}}
     *          redCells: 形如 { "行号_列号": true } 的超标单元格集合，供 applyCellStyles 上红
     */
    function buildAoa(parsed, identified, overrides, options) {
        var airports = global.AirportTemplate.airports;
        var total = airports.length;
        var publisher = (options && options.publisher) || '';
        var publishTime = (options && options.publishTime) || formatBeijingTime();
        var aoa = [];
        // 第 0 行：标题
        aoa.push([TITLE, '', '', '', '']);
        // 第 1 行：制作人（合并 5 列）
        var publisherCell = publisher
            ? PUBLISHER_PREFIX + publisher
            : PUBLISHER_PREFIX + '[点击输入姓名]';
        aoa.push([publisherCell, '', '', '', '']);
        // 第 2 行：发布时间（合并 5 列）
        aoa.push([PUBLISH_TIME_PREFIX + publishTime, '', '', '', '']);
        // 第 3 行：单行表头（机场 / 风速 / 天气现象 / 能见度 / 是否满足地面结冰条件）
        aoa.push([HEADERS[0], HEADERS[1], HEADERS[2], HEADERS[3], HEADERS[4]]);
        // 第 4~N 行：模板机场 + 初始"无"
        for (var i = 0; i < total; i++) {
            aoa.push([airports[i], '无', '无', '无', '无']);
        }

        var hits = [];
        // 缓存每行的"识别结果"（merged），在 overrides 应用后再判定超标，
        // 这样用户编辑成"是"的 E 列也能被识别为超标
        var mergedByRow = {};

        // 提取需要填表的目标 { icao, identified }
        var targets = collectTargets(parsed, identified);

        targets.forEach(function (t) {
            var icao = t.icao;
            var displayName = global.AirportTemplate.getNameByIcao(icao) || icao || '未知';
            var matchIdx = global.AirportTemplate.findIndexByIcao(icao);
            var targetRow;
            var appended = false;
            // 数据行从 row 4 开始（0 标题 / 1 制作人 / 2 发布时间 / 3 表头）
            if (matchIdx >= 0) {
                targetRow = 4 + matchIdx;
            } else {
                // 不在模板中：追加到表尾
                aoa.push([displayName, '无', '无', '无', '无']);
                targetRow = aoa.length - 1;
                appended = true;
            }
            applyIdentifiedToRow(aoa[targetRow], t.identified);
            mergedByRow[targetRow] = mergeIdentified(t.identified);
            hits.push({ icao: icao, rowIdx: targetRow, name: displayName, appended: appended });
        });

        // 应用用户在预览表格上编辑后的覆盖值
        // - 仅当列号在 0~4 之间（5 列：机场/时间/现象/能见度/结冰）
        // - 仅当行号在已生成的 aoa 范围内时生效（防御历史 overrides 越界）
        if (overrides && typeof overrides === 'object') {
            Object.keys(overrides).forEach(function (key) {
                var parts = String(key).split('_');
                if (parts.length < 2) return;
                var r = parseInt(parts[0], 10);
                var c = parseInt(parts[1], 10);
                if (!isFinite(r) || !isFinite(c)) return;
                if (r < 0 || r >= aoa.length) return;
                if (c < 0 || c > 4) return;
                if (!aoa[r]) aoa[r] = [];
                aoa[r][c] = String(overrides[key] == null ? '' : overrides[key]);
            });
        }

        // 标记"超标"单元格（供 applyCellStyles 渲染红色字体）
        // 判定在 overrides 应用之后进行，确保用户编辑后的"是"也能被高亮
        var redCells = {};
        Object.keys(mergedByRow).forEach(function (rowIdxStr) {
            var rowIdx = parseInt(rowIdxStr, 10);
            if (rowIdx < 0 || rowIdx >= aoa.length) return;
            var row = aoa[rowIdx];
            var flag = isExceed(mergedByRow[rowIdx], row);
            // 关键列（B 风速 / C 现象 / D 能见度 / E 结冰）
            if (flag.wind)        redCells[rowIdx + '_1'] = true;
            if (flag.phenomenon)  redCells[rowIdx + '_2'] = true;
            if (flag.visibility)  redCells[rowIdx + '_3'] = true;
            if (flag.ice)         redCells[rowIdx + '_4'] = true;
        });

        return { aoa: aoa, hits: hits, redCells: redCells };
    }

    /**
     * 从 parsed + identified 中提取「需要填表的目标列表」
     * - 多机场：返回所有机场的识别结果（按 TAF 时间戳倒序，方便最新事件先填）
     * - 单机场：仅 1 个目标
     */
    function collectTargets(parsed, identified) {
        if (!parsed) return [];
        if (parsed.isMultiAirport && parsed.selectedByIcao) {
            var arr = [];
            Object.keys(parsed.selectedByIcao).forEach(function (icao) {
                var one = (identified && identified.byIcao && identified.byIcao[icao])
                    ? identified.byIcao[icao]
                    : TafParser.identifyWindDustIce(parsed.selectedByIcao[icao], TafParser.DEFAULT_RULES);
                arr.push({ icao: icao, identified: one });
            });
            // 按 ICAO 顺序稳定排序：模板内机场靠前、追加机场在后
            arr.sort(function (a, b) {
                var ai = global.AirportTemplate.findIndexByIcao(a.icao);
                var bi = global.AirportTemplate.findIndexByIcao(b.icao);
                if (ai < 0 && bi < 0) return 0;
                if (ai < 0) return 1;
                if (bi < 0) return -1;
                return ai - bi;
            });
            return arr;
        }
        // 单机场：兼容两种调用方式（与 identifyWindDustIce 保持一致的 unwrap 逻辑）
        //   1. 传 parse() 的包装结果（含 selected/isMultiAirport/ignored）
        //   2. 直接传 TAF 解析结果（含 icao/validPeriod/main/changes）
        // 统一 unwrap 后再取 ICAO，避免外部传包装结果时 icao 为 undefined 导致「未知」
        var taf = (parsed && parsed.selected) ? parsed.selected : parsed;
        var icao = (taf && taf.icao) || '';
        var one = identified || TafParser.identifyWindDustIce(parsed, TafParser.DEFAULT_RULES);
        return [{ icao: icao, identified: one }];
    }

    /* ============================================================
     * SheetJS 调用
     * ============================================================ */

    /**
     * 把 aoa 写入工作簿并触发下载
     * 应用统一样式：水平居中 + 垂直居中；标题字号 16；有内容单元格全框线；行高自动
     * 超标单元格（B/C/D/E 列对应"风速/现象/能见度/结冰"）使用红色字体
     * @param {string[][]} aoa
     * @param {string} filename
     * @param {Object} [redCells] 形如 { "行号_列号": true }，标识需红色字体的单元格
     */
    function writeAndDownload(aoa, filename, redCells) {
        if (typeof global.XLSX === 'undefined') {
            if (global.Logger) global.Logger.error('XLSX 库未加载，请确认 assets/vendor/xlsx.bundle.js 已引入');
            throw new Error('XLSX 库未加载');
        }
        var ws = global.XLSX.utils.aoa_to_sheet(aoa);

        // ===== 列宽（与原模板接近，wch 是字符宽度） =====
        ws['!cols'] = [
            { wch: 12 },  // A 机场
            { wch: 20 },  // B 风速
            { wch: 18 },  // C 现象
            { wch: 14 },  // D 能见度
            { wch: 24 }   // E 结冰
        ];

        // ===== 合并单元格 =====
        // 行结构：0 标题 / 1 制作人 / 2 发布时间 / 3 表头（单行） / 4+ 数据
        ws['!merges'] = [
            { s: { r: 0, c: 0 }, e: { r: 0, c: 4 } },  // A1:E1 标题
            { s: { r: 1, c: 0 }, e: { r: 1, c: 4 } },  // A2:E2 制作人
            { s: { r: 2, c: 0 }, e: { r: 2, c: 4 } }   // A3:E3 发布时间
        ];

        // ===== 行高：根据内容自动调整 =====
        // SheetJS 的 auto 行高需要 sheetjs-style/pro 增强；
        // 这里用经验值：根据单元格换行符数量动态设置每行行高
        var rowHeights = [];
        rowHeights.push(30);  // 标题行（容纳 16 号字）
        rowHeights.push(20);  // 制作人行
        rowHeights.push(20);  // 发布时间行
        rowHeights.push(22);  // 表头
        for (var ri = 4; ri < aoa.length; ri++) {
            var maxLines = 1;
            for (var ci = 0; ci < aoa[ri].length; ci++) {
                var cell = String(aoa[ri][ci] || '');
                // 估算行数：换行符 + 中文字符自适应折行
                var lines = (cell.match(/\n/g) || []).length + 1;
                // B/C 列含较多中文时，一行可显示的字符数大约 11~13，按字符长度粗略估算
                if (cell.length > 18) {
                    lines += Math.ceil((cell.length - 18) / 14);
                }
                if (lines > maxLines) maxLines = lines;
            }
            // 每行高度：基础 22pt + 多出每行 18pt
            rowHeights.push(22 + (maxLines - 1) * 18);
        }
        ws['!rows'] = rowHeights.map(function (h) { return { hpt: h }; });

        // ===== 单元格样式 =====
        applyCellStyles(ws, aoa, redCells);

        var wb = global.XLSX.utils.book_new();
        global.XLSX.utils.book_append_sheet(wb, ws, 'Table 1');
        var out = global.XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
        var blob = new Blob([out], { type: 'application/octet-stream' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = filename || ('大风沙尘结冰通报_' + (global.Exporter ? global.Exporter.stamp() : Date.now()) + '.xlsx');
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        setTimeout(function () {
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        }, 100);
    }

    /**
     * 给工作表每个有内容的单元格应用统一样式
     * - 全部：水平居中 + 垂直居中
     * - 标题 A1：字号 16
     * - 有内容单元格：四周细线边框
     * - 超标单元格（redCells 命中）：红色字体（覆盖默认字色）
     */
    function applyCellStyles(ws, aoa, redCells) {
        if (!ws || !aoa) return;
        var range = global.XLSX.utils.decode_range(ws['!ref']);
        var thinBorder = {
            top: { style: 'thin', color: { rgb: 'FF7A7A7A' } },
            right: { style: 'thin', color: { rgb: 'FF7A7A7A' } },
            bottom: { style: 'thin', color: { rgb: 'FF7A7A7A' } },
            left: { style: 'thin', color: { rgb: 'FF7A7A7A' } }
        };
        var centerAlignment = { horizontal: 'center', vertical: 'center', wrapText: true };
        // 超标单元格字体颜色：纯红 FF0000
        var redFontColor = { rgb: 'FFFF0000' };

        for (var R = range.s.r; R <= range.e.r; R++) {
            for (var C = range.s.c; C <= range.e.c; C++) {
                var addr = global.XLSX.utils.encode_cell({ r: R, c: C });
                var cell = ws[addr];
                if (!cell) continue;
                var value = aoa[R] && aoa[R][C] !== undefined ? aoa[R][C] : cell.v;
                var hasContent = value !== undefined && value !== null && String(value).length > 0;
                if (!hasContent) continue;

                if (!cell.s) cell.s = {};
                // 全部：水平 + 垂直居中（包含 wrapText 处理多行内容）
                cell.s.alignment = Object.assign({}, centerAlignment);
                // 标题 A1：字号 16 + 加粗
                if (R === 0 && C === 0) {
                    cell.s.font = Object.assign({}, cell.s.font || {}, { sz: 16, bold: true });
                } else if (R === 1) {
                    // 制作人行：11pt + 加粗
                    cell.s.font = Object.assign({}, cell.s.font || {}, { sz: 11, bold: true });
                } else {
                    // 其它单元格默认 11pt（SheetJS 默认即可，无需强制设置）
                }
                // 有内容：全框线
                cell.s.border = JSON.parse(JSON.stringify(thinBorder));
                // 超标单元格：红色字体（覆盖字色，但保留字号/加粗等其它属性）
                if (redCells && redCells[R + '_' + C]) {
                    cell.s.font = Object.assign({}, cell.s.font || {}, { color: redFontColor });
                }
            }
        }
    }

    /* ============================================================
     * 对外 API
     * ============================================================ */

    /**
     * 导出 EXCEL 通报
     * @param {object} parsed TafParser.parse 返回的解析结果
     * @param {object} identified TafParser.identifyWindDustIce 返回值
     * @param {object} [options] { filename?: string, overrides?: object, publisher?: string }
     *        overrides: 用户在预览表格上编辑后的覆盖值
     *        publisher: 制作人姓名（写入 aoa[1]）
     * @returns {{success: boolean, message: string, hits: Array}}
     */
    function exportReport(parsed, identified, options) {
        try {
            if (!parsed) {
                return { success: false, message: '无 TAF 解析结果，请先解析报文', hits: [] };
            }
            var overrides = options && options.overrides;
            var publisher = options && options.publisher;
            var publishTime = options && options.publishTime;
            var built = buildAoa(parsed, identified, overrides, {
                publisher: publisher,
                publishTime: publishTime
            });
            var hits = built.hits || [];
            var defaultName;
            if (parsed.isMultiAirport) {
                defaultName = '大风沙尘结冰通报_多机场_' +
                    (global.Exporter ? global.Exporter.stamp() : Date.now()) + '.xlsx';
            } else {
                defaultName = '大风沙尘结冰通报_' + (parsed.icao || 'unknown') + '_' +
                    (global.Exporter ? global.Exporter.stamp() : Date.now()) + '.xlsx';
            }
            var filename = (options && options.filename) || defaultName;
            writeAndDownload(built.aoa, filename, built.redCells);
            var msg;
            if (parsed.isMultiAirport) {
                var matchedCount = hits.filter(function (h) { return !h.appended; }).length;
                var appendedCount = hits.filter(function (h) { return h.appended; }).length;
                msg = '已导出：共 ' + hits.length + ' 个机场（模板内 ' + matchedCount +
                    ' 个，追加 ' + appendedCount + ' 个）';
            } else if (hits[0]) {
                var h0 = hits[0];
                msg = h0.appended
                    ? '已导出：当前 ICAO "' + h0.icao + '" 不在模板中，已作为新行追加到表尾'
                    : '已导出：机场 "' + h0.name + '"（模板第 ' + (h0.rowIdx - 2) + ' 行）';
            } else {
                msg = '已导出：通报模板已生成';
            }
            if (global.Logger) global.Logger.info('导出 EXCEL 成功：' + filename + ' / 机场数 ' + hits.length);
            return { success: true, message: msg, hits: hits };
        } catch (e) {
            if (global.Logger) global.Logger.error('导出 EXCEL 失败', e);
            return { success: false, message: '导出失败：' + (e.message || e), hits: [] };
        }
    }

    global.XlsxExporter = {
        exportReport: exportReport,
        /**
         * 公开 API：构建 EXCEL 单元格数据（与导出文件完全一致）
         * - 供 wind-dust.js 用于在页面上实时渲染预览表格
         * - 同时保留旧名 __test_buildAoa 以兼容旧调用
         */
        buildAoa: buildAoa,
        __test_buildAoa: buildAoa
    };
})(window);
