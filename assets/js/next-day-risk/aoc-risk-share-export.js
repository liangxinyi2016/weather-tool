/**
 * 「导出 AOC 次日风险共享表格」模块
 * --------------------------------------------------------------------
 * 职责
 *   - 加载模板 `assets/templates/次日风险共享表格.xlsx`（含 2 个选项卡）
 *   - 附表2 风险评估要点：严格按截图"风险评估要点"分类填 A-D 列
 *       列结构：A 风险评估要点（动态写入） / B 危险源/潜在隐患 / C 风险等级/天气分级 / D 影响航班/机场/区域/飞机
 *       设计：每条 risk 展开为 N 个 entry（每种 weatherType 一个），每个 entry 占用独立一行
 *             A 列根据 entry 的分类动态写入对应标签（如"低云、低能见度"）
 *             严格保证"每行数据仅允许输入一个机场"，不再用 "；" 追加同一行的多条目
 *       9 个分类（与截图保持一致）：
 *         1. 低云、低能见度
 *         2. 侧风、顺风、大风
 *         3. 风切变
 *         4. 降水、雷雨
 *         5. 冰雪天气、凝冻天气
 *         6. 沙尘暴
 *         7. 火山灰
 *         8. 台风
 *         9. 颠簸、积冰
 *   - 附表3 复杂天气：按 level 分组填 A-E 列
 *       列结构：A 序号 / B 机场 / C 天气类型 / D 气象预报 / E 时间段
 *       2-5 : 高度关注（红，4 行；A2:A5 原合并在写入前解除以便写序号）
 *       6-9 : 中度关注（橙，4 行；A6:A9 同上）
 *       10-18: 一般关注（黄，9 行；A10:A18 同上）
 *   - 录入顺序：红 → 橙 → 黄（按等级分组，组内按用户录入顺序）
 *   - 录入完成后做"机场数量"检查：对比期望录入的机场数 vs 实际填入的机场数
 *   - 文件名：次日风险共享表格<MM月DD日>.xlsx（次日日期）
 *   - 保留模板原样式：合并单元格、底色、字体、边框、列宽
 *
 * 依赖
 *   - XLSX: xlsx-js-style（assets/vendor/xlsx.bundle.js）
 *   - airports.js: AirportTemplate.getNameByIcao
 *   - next-day-risk.js: NextDayRiskModule.getRisks
 *   - logger.js: Logger.info / warn / error
 *
 * 暴露：global.AocRiskShareExport = { exportRisks, _formatTimeRange, _mapWeatherToRow, _fillSheet2, _fillSheet3, _getNextDayDateLabel }
 */
(function (global) {
    'use strict';

    /* ============================================================
     * 常量
     * ============================================================ */

    /** 模板 URL（相对页面根） */
    var TEMPLATE_URL = 'assets/templates/次日风险共享表格.xlsx';

    /** 模板文件名 */
    var FILENAME_PREFIX = '次日风险共享表格';

    /**
     * 附表2 风险评估要点
     * --------------------------------------------------------------------
     * 设计原则（按用户要求）：
     *   - 严格按截图"风险评估要点"分类，每个 entry 写入时 A 列写对应分类标签
     *   - 每行数据仅允许输入一个机场（不再用 "；" 追加同一行的多个 entry）
     *   - 不对单元格进行合并：每行独立
     *   - 行的总数 = entry 总数，从行 2 开始按用户录入顺序动态分配
     *   - 同一分类的多个 entry 占连续行，A 列都写相同的分类标签
     *
     * 字段说明：
     *   - match: 用于匹配用户录入的 weatherType 的正则
     *   - label: 该分类在 A 列显示的标签（与截图保持一致）
     *
     * 匹配顺序（优先级）：
     *   1. 低云低能见度（最先匹配，优先于"降水"以正确归类"低云,降水"组合）
     *   2. 大风/侧风/顺风
     *   3. 风切变
     *   4. 降水/雷雨/雷暴
     *   5. 冰雪/凝冻
     *   6. 沙尘
     *   7. 火山灰
     *   8. 台风
     *   9. 颠簸/积冰
     */
    var SHEET2_ROW_CONFIG = [
        // {match: 正则, label: A 列分类标签}
        { match: /低云|低能见度/, label: '低云、低能见度' },            // 低云、低能见度
        { match: /大风|侧风|顺风/, label: '侧风、顺风、大风' },         // 侧风、顺风、大风
        { match: /风切变/, label: '风切变' },                            // 风切变
        { match: /降水|雷雨|雷暴/, label: '降水、雷雨' },                // 降水、雷雨
        { match: /冰雪|凝冻/, label: '冰雪天气、凝冻天气' },             // 冰雪天气、凝冻天气
        { match: /沙尘|沙尘暴/, label: '沙尘暴' },                       // 沙尘暴
        { match: /火山灰/, label: '火山灰' },                            // 火山灰
        { match: /台风/, label: '台风' },                                // 台风
        { match: /颠簸|积冰/, label: '颠簸、积冰' }                      // 颠簸、积冰
    ];

    /**
     * 附表3 数据位行范围（按等级）
     * 必须与模板合并区域严格对应：
     *   - 红 标题 A2:A5 合并，数据行 = 2,3,4,5（4 行）
     *   - 橙 标题 A6:A9 合并，数据行 = 6,7,8,9（4 行）
     *   - 黄 标题 A10:A18 合并，数据行 = 10-18（9 行）
     * start/end 仅指示"数据填入的行号"。A 列为"序号"合并标题，
     * 由 fillSheet3 在每个等级首行写入等级名称（如"高度关注"）。
     * @type {{红: {start: number, end: number}, 橙: {start: number, end: number}, 黄: {start: number, end: number}}}
     */
    var SHEET3_ROW_RANGES = {
        '红': { start: 2, end: 5 },       // 高度关注 4 行（A2-A5）
        '橙': { start: 6, end: 9 },       // 中度关注 4 行（A6-A9）
        '黄': { start: 10, end: 18 }      // 一般关注 9 行（A10-A18）
    };

    /**
     * 附表3 A 列等级标签（A 列为合并标题列）
     *   红 → 高度关注
     *   橙 → 中度关注
     *   黄 → 一般关注
     * @type {{红: string, 橙: string, 黄: string}}
     */
    var SHEET3_LEVEL_LABEL = {
        '红': '高度关注',
        '橙': '中度关注',
        '黄': '一般关注'
    };

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
     * 计算次日的 MM月DD日 标签
     * @param {Date} [d]
     * @returns {string} 例: "07月22日"
     */
    function getNextDayDateLabel(d) {
        if (!d) d = new Date();
        var next = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
        return pad2(next.getMonth() + 1) + '月' + pad2(next.getDate()) + '日';
    }

    /**
     * 从 "2026/7/20 06:00:00" 中提取小时数（两位字符串）
     * @param {string} t
     * @returns {string} 例: "06"
     */
    function extractHour(t) {
        if (!t) return '';
        var s = String(t);
        var m = s.match(/(\d{1,2}):\d{2}/);
        if (!m) return '';
        return pad2(parseInt(m[1], 10));
    }

    /**
     * 将开始/结束时间格式化为 "HH-HH" 形式
     * @param {string} startTime 例: "2026/7/20 06:00:00"
     * @param {string} endTime 例: "2026/7/20 19:00:00"
     * @returns {string} 例: "06-19"
     */
    function formatTimeRange(startTime, endTime) {
        var sh = extractHour(startTime);
        var eh = extractHour(endTime);
        if (!sh && !eh) return '';
        if (!sh) return eh;
        if (!eh) return sh;
        return sh + '-' + eh;
    }

    /**
     * 取 ICAO 对应的中文机场名（找不到则返回 ICAO 原文）
     * @param {string} icao
     * @returns {string}
     */
    function getAirportName(icao) {
        if (!icao) return '';
        if (global.AirportTemplate && typeof global.AirportTemplate.getNameByIcao === 'function') {
            var n = global.AirportTemplate.getNameByIcao(icao);
            if (n) return n;
        }
        return icao;
    }

    /**
     * 将关注等级（红/橙/黄）映射为 AOC 业务规范文本
     * 红 → 4级/红色预警
     * 橙 → 3级/橙色预警
     * 黄 → 3级/黄色预警
     * 未知 → ''（空字符串）
     * @param {string} level
     * @returns {string}
     */
    function formatLevel(level) {
        if (!level) return '';
        if (level === '红') return '4级/红色预警';
        if (level === '橙') return '3级/橙色预警';
        if (level === '黄') return '3级/黄色预警';
        return '';
    }

    /**
     * 航班数据文件路径（兜底 URL，浏览器侧 fetch）
     * 注：路径含空格与括号，需 URL 编码后用于 fetch
     * 当用户未上传文件且 storage 无缓存时，自动回落到此 URL 加载
     */
    var FLIGHTS_URL = '#/%E8%88%AA%E7%8F%AD%E5%8A%A8%E6%80%81%20(3).xls';

    /** 航班缓存存储键（chrome.storage.local 优先；降级 localStorage） */
    var FLIGHTS_CACHE_KEY = 'met_tool_aoc_flights_cache';

    /**
     * localStorage 键名（与 chrome.storage.local 保持解耦）
     * 完整结构：{ flights: [...], source: 'upload'|'url'|'cache', updatedAt: 'ISO' }
     */
    function localCacheKey() { return 'met_tool:' + FLIGHTS_CACHE_KEY; }

    /** 内存缓存：避免每次导出都读取 storage */
    var flightsCache = {
        loaded: false,    // 是否已尝试加载过
        flights: [],      // 当前内存中的航班数组
        source: '',       // 'cache' | 'url' | 'upload' | ''
        updatedAt: ''
    };

    /**
     * 解析航班数据工作表为标准化航班数组
     * 输入：xlsx-js-style 解析后的工作表（Data 表，列结构参见 spec）
     * 输出：[ { flightNo, dep, depTime, arr, arrTime, arrTimeEst } ]
     *   - flightNo: D 列 航班号
     *   - dep: F 列 起站（中文名）
     *   - depTime: G 列 计划离港时间
     *   - arr: J 列 落站（中文名）
     *   - arrTime: K 列 计划到港时间
     *   - arrTimeEst: L 列 预计到港时间（可能为空）
     * 仅保留执行状态（Q 列）= '计划' 的航班
     * @param {object} ws XLSX worksheet
     * @returns {Array}
     */
    function parseFlightsWorksheet(ws) {
        if (!ws || !ws['!ref'] || !global.XLSX) return [];
        var range = global.XLSX.utils.decode_range(ws['!ref']);
        var result = [];
        for (var r = range.s.r + 1; r <= range.e.r; r++) {
            // 列定义（0-based）：D=3, F=5, G=6, J=9, K=10, L=11, Q=16
            var flightNo = getCellString(ws, r, 3);
            var dep = getCellString(ws, r, 5);
            var depTime = getCellString(ws, r, 6);
            var arr = getCellString(ws, r, 9);
            var arrTime = getCellString(ws, r, 10);
            var arrTimeEst = getCellString(ws, r, 11);
            var status = getCellString(ws, r, 16);
            // 仅保留执行状态='计划'的航班
            if (status !== '计划') continue;
            // 必要字段缺失则跳过
            if (!flightNo || !dep || !arr || !depTime) continue;
            result.push({
                flightNo: flightNo,
                dep: dep,
                depTime: depTime,
                arr: arr,
                arrTime: arrTime,
                arrTimeEst: arrTimeEst
            });
        }
        return result;
    }

    /**
     * 读取单元格字符串值（兼容数值/日期/空）
     * @param {object} ws
     * @param {number} r 0-based 行
     * @param {number} c 0-based 列
     * @returns {string}
     */
    function getCellString(ws, r, c) {
        var addr = global.XLSX.utils.encode_cell({ r: r, c: c });
        var cell = ws[addr];
        if (!cell) return '';
        if (cell.v === undefined || cell.v === null) return '';
        return String(cell.v).trim();
    }

    /**
     * 异步加载航班动态文件并解析为航班数组
     * 失败时返回 []（不抛错）
     * @param {string} [url] 可选 URL，默认 FLIGHTS_URL
     * @returns {Promise<Array>}
     */
    function loadFlightsFromUrl(url) {
        var target = url || FLIGHTS_URL;
        return new Promise(function (resolve) {
            if (typeof fetch === 'undefined' || !global.XLSX) {
                if (global.Logger) global.Logger.warn('[Aoc] 缺少 fetch/XLSX，无法加载航班数据');
                resolve([]);
                return;
            }
            fetch(target)
                .then(function (resp) {
                    if (!resp || !resp.ok) {
                        if (global.Logger) global.Logger.warn('[Aoc] 航班文件 HTTP 失败: ' + (resp && resp.status));
                        return [];
                    }
                    return resp.arrayBuffer();
                })
                .then(function (buf) {
                    if (!buf) return [];
                    try {
                        var wb = global.XLSX.read(buf, { type: 'array' });
                        // 优先匹配 'Data'，否则取第一个工作表
                        var ws = wb.Sheets['Data'] || wb.Sheets[wb.SheetNames[0]];
                        if (!ws) return [];
                        return parseFlightsWorksheet(ws);
                    } catch (e) {
                        if (global.Logger) global.Logger.error('[Aoc] 航班文件解析失败: ' + e.message);
                        return [];
                    }
                })
                .then(resolve)
                .catch(function (e) {
                    if (global.Logger) global.Logger.warn('[Aoc] 航班文件加载失败: ' + (e && e.message));
                    resolve([]);
                });
        });
    }

    /**
     * 解析用户上传的航班文件（File 对象）→ 航班数组
     * 浏览器侧用 FileReader.readAsArrayBuffer + XLSX.read
     * @param {File} file 用户选择的 .xls / .xlsx 文件
     * @returns {Promise<Array>} 成功 resolve 航班数组；失败 resolve []
     */
    function parseFlightsFile(file) {
        return new Promise(function (resolve) {
            if (!file) { resolve([]); return; }
            if (!global.XLSX) {
                if (global.Logger) global.Logger.error('[Aoc] XLSX 库未加载，无法解析航班文件');
                resolve([]);
                return;
            }
            try {
                var reader = new FileReader();
                reader.onload = function (e) {
                    try {
                        var buf = e && e.target && e.target.result;
                        if (!buf) { resolve([]); return; }
                        var wb = global.XLSX.read(buf, { type: 'array' });
                        var ws = wb.Sheets['Data'] || wb.Sheets[wb.SheetNames[0]];
                        if (!ws) { resolve([]); return; }
                        resolve(parseFlightsWorksheet(ws));
                    } catch (err) {
                        if (global.Logger) global.Logger.error('[Aoc] 上传文件解析失败: ' + (err && err.message));
                        resolve([]);
                    }
                };
                reader.onerror = function () {
                    if (global.Logger) global.Logger.error('[Aoc] FileReader 读取失败');
                    resolve([]);
                };
                // 以 ArrayBuffer 方式读取，可同时支持 .xls（BIFF）和 .xlsx（OOXML）
                reader.readAsArrayBuffer(file);
            } catch (e) {
                if (global.Logger) global.Logger.error('[Aoc] parseFlightsFile 异常: ' + (e && e.message));
                resolve([]);
            }
        });
    }

    /**
     * 从 chrome.storage.local（优先）/ localStorage（降级）读取航班缓存
     * @returns {Promise<{flights: Array, source: string, updatedAt: string}|null>}
     */
    function readFlightsCache() {
        return new Promise(function (resolve) {
            var finish = function (payload) {
                if (payload && Array.isArray(payload.flights) && payload.flights.length) {
                    resolve({
                        flights: payload.flights,
                        source: payload.source || 'cache',
                        updatedAt: payload.updatedAt || ''
                    });
                } else {
                    resolve(null);
                }
            };
            try {
                if (global.chrome && chrome.storage && chrome.storage.local) {
                    chrome.storage.local.get(FLIGHTS_CACHE_KEY, function (data) {
                        var v = data && data[FLIGHTS_CACHE_KEY];
                        if (v) { finish(v); return; }
                        // 降级 localStorage
                        try {
                            var raw = global.localStorage.getItem(localCacheKey());
                            if (!raw) { resolve(null); return; }
                            finish(JSON.parse(raw));
                        } catch (e) { resolve(null); }
                    });
                    return;
                }
            } catch (e) { /* fall through */ }
            // 无 chrome.storage：直接读 localStorage
            try {
                var raw2 = global.localStorage.getItem(localCacheKey());
                if (!raw2) { resolve(null); return; }
                finish(JSON.parse(raw2));
            } catch (e) { resolve(null); }
        });
    }

    /**
     * 写入航班缓存到 chrome.storage.local（优先）+ localStorage（兜底）
     * @param {Array} flights 航班数组
     * @param {string} source 来源 'upload' | 'url'
     * @returns {Promise<boolean>}
     */
    function writeFlightsCache(flights, source) {
        return new Promise(function (resolve) {
            if (!Array.isArray(flights)) { resolve(false); return; }
            var payload = {
                flights: flights,
                source: source || 'cache',
                updatedAt: new Date().toISOString()
            };
            // 始终同步写入 localStorage 兜底
            try { global.localStorage.setItem(localCacheKey(), JSON.stringify(payload)); } catch (e) {}
            try {
                if (global.chrome && chrome.storage && chrome.storage.local) {
                    var obj = {}; obj[FLIGHTS_CACHE_KEY] = payload;
                    chrome.storage.local.set(obj, function () { resolve(true); });
                    return;
                }
            } catch (e) { /* fall through */ }
            resolve(true);
        });
    }

    /**
     * 清除航班缓存（chrome.storage.local + localStorage）
     * @returns {Promise<boolean>}
     */
    function clearFlightsCache() {
        return new Promise(function (resolve) {
            try { global.localStorage.removeItem(localCacheKey()); } catch (e) {}
            try {
                if (global.chrome && chrome.storage && chrome.storage.local) {
                    chrome.storage.local.remove(FLIGHTS_CACHE_KEY, function () { resolve(true); });
                    return;
                }
            } catch (e) { /* fall through */ }
            resolve(true);
        });
    }

    /**
     * 统一入口：按「缓存 → URL 回落」加载航班数据
     * 命中缓存时直接返回；未命中则从 FLIGHTS_URL 加载并写缓存
     * 全部失败时返回 []
     * @returns {Promise<Array>}
     */
    function loadFlightsWithCache() {
        // 1) 先尝试命中本地缓存（避免每次重新解析）
        return readFlightsCache().then(function (cached) {
            if (cached && cached.flights && cached.flights.length) {
                flightsCache.flights = cached.flights;
                flightsCache.source = cached.source || 'cache';
                flightsCache.updatedAt = cached.updatedAt || '';
                flightsCache.loaded = true;
                if (global.Logger) global.Logger.info('[Aoc] 命中航班缓存: ' + flightsCache.flights.length + ' 条, 来源=' + flightsCache.source);
                return flightsCache.flights;
            }
            // 2) 回落 fetch 兜底 URL
            return loadFlightsFromUrl(FLIGHTS_URL).then(function (list) {
                flightsCache.flights = list || [];
                flightsCache.source = 'url';
                flightsCache.updatedAt = new Date().toISOString();
                flightsCache.loaded = true;
                if (list && list.length) {
                    // 写缓存（不阻塞主流程）
                    writeFlightsCache(list, 'url').then(function () {
                        if (global.Logger) global.Logger.info('[Aoc] URL 航班已写缓存: ' + list.length + ' 条');
                    });
                } else if (global.Logger) {
                    global.Logger.warn('[Aoc] URL 回落也未获取到航班，附表2 D 列将留空');
                }
                return flightsCache.flights;
            });
        });
    }

    /**
     * 规范化时间字符串为「YYYY/MM/DD HH:mm:ss」形式（用于字符串比较）
     * 真实航班数据使用「YYYY-MM-DD HH:mm:ss」格式（如 2026-07-23 06:40:00）
     * 风险数据使用「YYYY/M/D HH:mm:ss」格式（如 2026/7/22 06:00:00）
     * 若分隔符或位数不一致，字符串比较会得到错误结果（'-' < '/'）
     * 此函数统一转为「YYYY/MM/DD HH:mm:ss」便于直接 < > 比较
     * @param {string} t
     * @returns {string} 规范化后字符串；解析失败返回原值
     */
    function normalizeTimeStr(t) {
        if (!t) return '';
        var s = String(t).trim();
        var m = s.match(/^(\d{4})[\-\/](\d{1,2})[\-\/](\d{1,2})\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?/);
        if (!m) return s;
        function p2(n) { return parseInt(n, 10) < 10 ? '0' + parseInt(n, 10) : '' + parseInt(n, 10); }
        return m[1] + '/' + p2(m[2]) + '/' + p2(m[3]) + ' ' + p2(m[4]) + ':' + p2(m[5]) + ':' + p2(m[6] || '0');
    }

    /**
     * 收集指定 ICAO 在 NAME_TO_ICAO 中对应的所有可能中文名
     * 解决「模板名 vs 航班数据实际名称」不一致导致的匹配失败
     * 例：ZBHZ → ["霍林河"]（NAME_TO_ICAO 中只此一条）
     *     ZBHH → ["呼和浩特"]
     *     ZUTF → ["成都", "成都天府"]（C0039 主条目 + 模板别名）
     * @param {string} icao
     * @returns {string[]} 名称列表（可能为空数组）
     */
    function getAirportNameCandidates(icao) {
        var list = [];
        if (!icao) return list;
        var code = String(icao).toUpperCase();
        // 1) 优先从 airports.js 的 NAME_TO_ICAO 收集
        try {
            if (global.AirportTemplate && global.AirportTemplate.nameToIcao) {
                var map = global.AirportTemplate.nameToIcao;
                for (var name in map) {
                    if (Object.prototype.hasOwnProperty.call(map, name) &&
                        String(map[name]).toUpperCase() === code &&
                        list.indexOf(name) < 0) {
                        list.push(name);
                    }
                }
            }
        } catch (e) { /* ignore */ }
        // 2) 兜底：若 NAME_TO_ICAO 找不到，尝试从 airports 数组查（部分模块可能未暴露 nameToIcao）
        if (!list.length) {
            try {
                if (global.AirportTemplate && Array.isArray(global.AirportTemplate.airports)) {
                    global.AirportTemplate.airports.forEach(function (a) {
                        if (a && String(a.icao || '').toUpperCase() === code && a.city && list.indexOf(a.city) < 0) {
                            list.push(a.city);
                        }
                    });
                }
            } catch (e) { /* ignore */ }
        }
        // 3) 兜底：把 ICAO 本身也作为候选（防止 NAME_TO_ICAO 缺失）
        if (!list.length) list.push(code);
        return list;
    }

    /**
     * 筛选指定风险的影响航班
     * 规则（参见 spec）：
     *   1) 执行状态：'计划'（在 parseFlightsWorksheet 中已过滤）
     *   2) 机场匹配：dep 或 arr 属于「该 ICAO 的所有可能名称集合」
     *      - 解决「霍林河」风险匹配航班数据中的「霍林郭勒」一类别名不一致问题
     *      - 解决「成都」风险匹配「成都天府」一类 C0039 与模板名称不一致问题
     *   3) 时间窗口（按 dep/arr 分别判断，OR 关系）：
     *      a) 若 dep（起站）是风险机场 → 计划离港时间 depTime 必须位于 [startTime, endTime] 之间
     *      b) 若 arr（落站）是风险机场 → 计划到港时间 arrTime 必须位于 [startTime, endTime] 之间
     *      c) dep 与 arr 任一满足即视为影响航班
     *   4) 落地时间统一使用计划到港时间 arrTime（K 列），不使用预计到港 arrTimeEst
     *   5) 时间比较前先 normalize（航班「2026-07-23 06:40:00」↔ 风险「2026/7/22 06:00:00」）
     * @param {Array} flights 航班数组
     * @param {object} risk 风险对象
     * @returns {Array} 匹配航班子集（保持 flights 原顺序）
     */
    function filterFlightsForRisk(flights, risk) {
        if (!flights || !flights.length || !risk) return [];
        var airportCandidates = getAirportNameCandidates(risk.icao);
        if (!airportCandidates.length) return [];
        var startTime = normalizeTimeStr((risk.startTime && risk.startTime.value) || '');
        var endTime = normalizeTimeStr((risk.endTime && risk.endTime.value) || '');
        if (!startTime || !endTime) return [];

        var result = [];
        for (var i = 0; i < flights.length; i++) {
            var f = flights[i];
            // 1) dep / arr 至少有一个属于风险机场候选集
            var depIsRisk = airportCandidates.indexOf(f.dep) >= 0;
            var arrIsRisk = airportCandidates.indexOf(f.arr) >= 0;
            if (!depIsRisk && !arrIsRisk) continue;

            // 2) 分别按"起站是风险机场 → 检查 depTime"、"落站是风险机场 → 检查 arrTime"判断
            var depInWindow = false;
            var arrInWindow = false;

            if (depIsRisk && f.depTime) {
                var depNorm = normalizeTimeStr(f.depTime);
                depInWindow = depNorm >= startTime && depNorm <= endTime;
            }
            if (arrIsRisk && f.arrTime) {
                var arrNorm = normalizeTimeStr(f.arrTime);
                arrInWindow = arrNorm >= startTime && arrNorm <= endTime;
            }

            // 3) dep 在窗口内（dep 是风险机场）或 arr 在窗口内（arr 是风险机场）→ 匹配
            //    即 "dep 是风险机场且 dep 在窗口内" OR "arr 是风险机场且 arr 在窗口内"
            if (!depInWindow && !arrInWindow) continue;
            result.push(f);
        }
        return result;
    }

    /**
     * 将匹配航班数组格式化为「航班号 起站-落站，...」文本
     *   - 0 条：返回 ''
     *   - 1 条：'DR6563昆明-珠海'
     *   - N 条：'DR6563昆明-珠海，DR6565昆明-南宁'（中文逗号分隔）
     * @param {Array} matchedFlights
     * @returns {string}
     */
    function buildAffectedFlightsText(matchedFlights) {
        if (!matchedFlights || !matchedFlights.length) return '';
        var parts = [];
        for (var i = 0; i < matchedFlights.length; i++) {
            var f = matchedFlights[i];
            if (!f || !f.flightNo) continue;
            parts.push(f.flightNo + (f.dep || '') + '-' + (f.arr || ''));
        }
        return parts.join('，');
    }

    /**
     * 将 weatherTypes 数组映射到附表2 分类配置
     * 匹配规则：按 SHEET2_ROW_CONFIG 顺序查找首个匹配的分类
     * @param {string[]} weatherTypes
     * @returns {object|null} 分类配置对象（{match, label}）；无匹配返回 null
     */
    function mapWeatherToRow(weatherTypes) {
        if (!weatherTypes || !weatherTypes.length) return null;
        var types = weatherTypes.join('|');
        for (var i = 0; i < SHEET2_ROW_CONFIG.length; i++) {
            if (SHEET2_ROW_CONFIG[i].match.test(types)) {
                return SHEET2_ROW_CONFIG[i];
            }
        }
        return null;
    }

    /**
     * 判断 weatherTypes 数组是否匹配指定的正则分类
     * @param {string[]} weatherTypes
     * @param {RegExp} regex
     * @returns {boolean}
     */
    function matchWeatherCategory(weatherTypes, regex) {
        if (!weatherTypes || !weatherTypes.length) return false;
        return regex.test(weatherTypes.join('|'));
    }

    /**
     * 按用户输入顺序查找首个匹配的分类（用户的首要分类）
     * 规则：
     *   - 优先按 weatherTypes 中元素的顺序逐个尝试
     *   - 同一类型在 SHEET2_ROW_CONFIG 中按配置顺序找第一个匹配的配置
     *   - 用于确定"该 risk 应归到哪个分类"以及"括号内显示哪个具体类型"
     * @param {string[]} weatherTypes 用户输入的天气类型数组
     * @returns {{cfg: object, matchedType: string}|null}
     *   - cfg: SHEET2_ROW_CONFIG 中命中的分类配置
     *   - matchedType: 触发命中的具体用户类型（首个匹配上的那个）
     *   - 全部未匹配返回 null
     */
    function findFirstMatchingCategory(weatherTypes) {
        if (!weatherTypes || !weatherTypes.length) return null;
        for (var ti = 0; ti < weatherTypes.length; ti++) {
            var type = weatherTypes[ti];
            if (!type) continue;
            for (var ci = 0; ci < SHEET2_ROW_CONFIG.length; ci++) {
                if (SHEET2_ROW_CONFIG[ci].match.test(type)) {
                    return { cfg: SHEET2_ROW_CONFIG[ci], matchedType: String(type) };
                }
            }
        }
        return null;
    }

    /**
     * 更新附表2 A 列分类标签的括号内容
     *   - 找到 cfg.startRow 对应的 A 列单元格
     *   - 若原文含「（...）」中文括号，则将括号内文本替换为 matchedType，保留前后缀
     *   - 若无括号，则保持原文不变（避免出现"火山灰（火山灰）"这类冗余）
     *   - 保留原单元格样式（字体/底色/合并等），仅刷新边框+居中样式
     * @param {object} ws XLSX worksheet（附表2）
     * @param {object} cfg SHEET2_ROW_CONFIG 分类配置
     * @param {string} matchedType 应当填入括号的天气类型
     * @returns {boolean} true=有更新；false=无变化或跳过
     */
    function updateCategoryLabel(ws, cfg, matchedType) {
        if (!ws || !cfg || !matchedType) return false;
        if (!global.XLSX) return false;
        var addr = global.XLSX.utils.encode_cell({ r: cfg.startRow - 1, c: 0 });
        var cell = ws[addr];
        if (!cell) return false;
        var original = String(cell.v || '').trim();
        if (!original) return false;
        // 匹配: 前缀 + （内容） + 后缀；括号内不允许再嵌括号
        var m = original.match(/^(.*?)（[^（）]*）([\s\S]*)$/);
        var newText;
        if (m) {
            newText = m[1] + '（' + matchedType + '）' + (m[2] || '');
        } else {
            // 无括号：保持原文（不让"火山灰"变成"火山灰（火山灰）"）
            return false;
        }
        if (newText === original) return false;
        ws[addr] = Object.assign({}, cell, {
            v: newText,
            w: newText,
            t: 's',
            s: buildBaseStyle(cell.s)
        });
        return true;
    }

    /**
     * 构造 thin 边框样式对象（四个边都使用细实线）
     * @returns {object}
     */
    function thinBorder() {
        return {
            top: { style: 'thin', color: { rgb: 'FF000000' } },
            bottom: { style: 'thin', color: { rgb: 'FF000000' } },
            left: { style: 'thin', color: { rgb: 'FF000000' } },
            right: { style: 'thin', color: { rgb: 'FF000000' } }
        };
    }

    /**
     * 构造单元格基础样式：四边细边框 + 水平/垂直居中 + 自动换行
     * 用于 setCell 与 applyBaseStyle
     * @param {object} [oldStyle] 单元格原有样式（用于保留字体/底色等）
     * @returns {object}
     */
    function buildBaseStyle(oldStyle) {
        var merged = Object.assign({}, oldStyle || {});
        merged.border = thinBorder();
        merged.alignment = Object.assign(
            { horizontal: 'center', vertical: 'center', wrapText: true },
            merged.alignment || {}
        );
        return merged;
    }

    /**
     * 判断某个单元格地址是否属于某个合并区域（且不是左上角的 cell）
     * 用于在 applyBaseStyle 中跳过合并区域内的子 cell，避免破坏模板的合并
     * @param {string} addr 如 "A3"
     * @param {Array<{s:{r:number,c:number},e:{r:number,c:number}}>} merges
     * @returns {boolean} true = 是合并区域中的非左上 cell（应跳过）
     */
    function isMergedSubCell(addr, merges) {
        if (!addr || !merges || !merges.length || !global.XLSX) return false;
        var decoded = global.XLSX.utils.decode_cell(addr);
        for (var i = 0; i < merges.length; i++) {
            var m = merges[i];
            if (!m || !m.s || !m.e) continue;
            // 在合并范围内
            if (decoded.r >= m.s.r && decoded.r <= m.e.r &&
                decoded.c >= m.s.c && decoded.c <= m.e.c) {
                // 跳过左上角本身（只标记"非左上"的子 cell）
                if (decoded.r !== m.s.r || decoded.c !== m.s.c) {
                    return true;
                }
            }
        }
        return false;
    }

    /**
     * 解除附表3 A 列从第 3 行开始的合并区域
     * 保留 A2（行2标题）的合并不处理，后续由 writeSheet3TitleRow 单独写入标题
     */
    function unmergeSheet3ColumnA(ws) {
        if (!ws || !ws['!merges']) return;
        ws['!merges'] = (ws['!merges'] || []).filter(function (m) {
            if (m.s && m.e && m.s.c === 0 && m.e.c === 0) {
                // 只解除从行 3 开始（0-based r>=2）的合并，保留行 2 的合并
                if (m.s.r >= 2) {
                    return false;
                }
            }
            return true;
        });
    }

    /**
     * 写入附表3第 2 行的标题栏
     * A=序号, B=机场, C=天气类型, D=气象预报, E=时间段, F 留空
     * 写入前会解除行2的合并（如果存在），确保每个单元格可独立写入
     * @param {object} ws XLSX worksheet
     */
    function writeSheet3TitleRow(ws) {
        if (!ws || !global.XLSX) return;

        // 解除行 2 A 列（r=1, c=0）与其他行的合并，只保留 r=1 自身的范围
        ws['!merges'] = (ws['!merges'] || []).filter(function (m) {
            if (m.s && m.e && m.s.c === 0 && m.e.c === 0 &&
                m.s.r === 1 && m.e.r >= 1) {
                // 如果合并正好是 A2:A2，保留；否则移除此合并
                if (m.e.r === 1) return true;
                return false;
            }
            return true;
        });

        var titles = {
            1: '序号',
            2: '机场',
            3: '天气类型',
            4: '气象预报',
            5: '时间段'
        };
        // F 列（6）留空

        for (var c = 1; c <= 5; c++) {
            setCell(ws, 2, c, titles[c]);
            // 标题样式：加粗+居中（应用基础样式）
            var addr = global.XLSX.utils.encode_cell({ r: 1, c: c - 1 });
            if (ws[addr]) {
                var baseStyle = buildBaseStyle(ws[addr].s);
                baseStyle.font = Object.assign({}, baseStyle.font || {}, { bold: true });
                ws[addr].s = baseStyle;
            }
        }

        // 清除模板原有的等级标签（解除合并后，这些单元格仍残留文字，会在空白处显示为多余内容）
        //   A2  原"高度关注" → 已被上面标题覆盖
        //   A10 原"中度关注" → 需要清除
        //   A18 原"一般关注" → 需要清除
        var staleLabelRows = [10, 18];
        for (var i = 0; i < staleLabelRows.length; i++) {
            var staleAddr = global.XLSX.utils.encode_cell({ r: staleLabelRows[i] - 1, c: 0 });
            if (ws[staleAddr]) {
                // 保留样式（底色/边框等），仅清空文字内容
                ws[staleAddr].v = '';
                ws[staleAddr].t = 's';
                ws[staleAddr].w = '';
            }
        }
    }

    /**
     * 给指定单元格应用关注等级样式（底色 + 字体）
     * 用于 fillSheet3 在写入数据时直接染色
     * @param {object} ws XLSX worksheet
     * @param {number} row 1-based 行
     * @param {string} lv 等级 ('红'|'橙'|'黄')
     */
    function applyLevelStyleToRow(ws, row, lv) {
        if (!ws || !global.XLSX || !LEVEL_FILL[lv]) return;
        for (var col = 0; col <= 4; col++) { // A-E 列
            var addr = global.XLSX.utils.encode_cell({ r: row - 1, c: col });
            var old = ws[addr] || { v: '', t: 's', w: '' };
            var baseStyle = buildBaseStyle(old.s);
            baseStyle.fill = {
                patternType: 'solid',
                fgColor: { rgb: LEVEL_FILL[lv] },
                bgColor: { rgb: LEVEL_FILL[lv] }
            };
            baseStyle.font = Object.assign({}, baseStyle.font || {}, LEVEL_FONT[lv]);
            ws[addr] = Object.assign({}, old, { s: baseStyle });
        }
    }

    /**
     * 批量给工作表的所有单元格应用边框 + 居中
     * 范围：!ref 描述的矩形区域
     * - 对所有有内容的单元格：追加边框 + 居中（保留原字体/底色/合并等）
     * - 对空白单元格：创建占位（v=''）以确保边框可见
     * - 跳过属于合并区域子 cell 的位置（不创建占位，避免破坏 A2:A3 / A7:A10 / A12:A14 等模板合并）
     * - 清空固定行高配置（让 Excel 根据内容自动调整）
     * @param {object} ws XLSX worksheet
     */
    function applyBaseStyle(ws) {
        if (!ws || !ws['!ref'] || !global.XLSX) return;
        var range = global.XLSX.utils.decode_range(ws['!ref']);
        var merges = ws['!merges'] || [];
        for (var r = range.s.r; r <= range.e.r; r++) {
            for (var c = range.s.c; c <= range.e.c; c++) {
                var addr = global.XLSX.utils.encode_cell({ r: r, c: c });
                // 关键修复：合并区域内的子 cell（A3/A8-A10/A13-A14 等）跳过，
                // 否则创建占位会破坏 A2:A3 / A7:A10 / A12:A14 的合并
                if (isMergedSubCell(addr, merges)) continue;
                var old = ws[addr];
                if (!old) {
                    // 占位空单元格：v='' + 基础样式
                    ws[addr] = { v: '', t: 's', w: '', s: buildBaseStyle() };
                } else {
                    ws[addr] = Object.assign({}, old, { s: buildBaseStyle(old.s) });
                }
            }
        }
        clearFixedRowHeights(ws);
    }

    /**
     * 清除工作表中的固定行高配置
     * 删除 ws['!rows'] 中所有 hpt/hpx 属性，让 Excel 根据内容自动调整行高
     * @param {object} ws XLSX worksheet
     */
    function clearFixedRowHeights(ws) {
        if (!ws) return;
        var ref = ws['!ref'] || 'A1:A1';
        var range = global.XLSX.utils.decode_range(ref);
        var rowCount = range.e.r - range.s.r + 1;
        var newRows = [];
        for (var i = 0; i < rowCount; i++) newRows.push({});
        ws['!rows'] = newRows;
    }

    /**
     * 附表3 关注等级背景色配置
     * key = 等级（红/橙/黄），value = 底色 RGB（去掉 FF 前缀用于 cell.fill.fgColor.rgb）
     */
    var LEVEL_FILL = {
        '红': 'FFFF0000',  // 高度关注
        '橙': 'FFFFA500',  // 中度关注
        '黄': 'FFFFFF00'   // 一般关注
    };

    /**
     * 附表3 等级文本色：白底深色，黑色加粗，确保彩色背景下可读
     */
    var LEVEL_FONT = {
        '红': { color: { rgb: 'FFFFFFFF' }, bold: true },
        '橙': { color: { rgb: 'FF000000' }, bold: true },
        '黄': { color: { rgb: 'FF000000' }, bold: true }
    };

    /**
     * 给附表3 中红/橙/黄关注等级区域统一染色（保留边框和居中）
     * 数据行（A2-A5 红 / A6-A9 橙 / A10-A18 黄）的 A-E 列涂上对应等级底色
     * - 染 A-E 列（含 A 列序号列和 B-E 数据列），F 列留空
     * - 跳过合并子单元格，防止破坏模板合并区域
     * - 等级文字保持原样
     * @param {object} ws 附表3 worksheet
     */
    function applyLevelColors(ws) {
        if (!ws || !global.XLSX) return;
        var ranges = SHEET3_ROW_RANGES;
        var merges = ws['!merges'] || [];
        Object.keys(ranges).forEach(function (lv) {
            if (!LEVEL_FILL[lv]) return;
            var range = ranges[lv];
            for (var row = range.start; row <= range.end; row++) {
                // 染色 A-E 列（c=0..4），F 列留空
                for (var col = 0; col <= 4; col++) {
                    var addr = global.XLSX.utils.encode_cell({ r: row - 1, c: col });
                    // 跳过合并区域内的子单元格，保护模板合并结构
                    if (isMergedSubCell(addr, merges)) continue;
                    var old = ws[addr] || { v: '', t: 's', w: '' };
                    // 合并样式：保留原样式，强制覆盖底色与字体
                    var baseStyle = buildBaseStyle(old.s);
                    baseStyle.fill = {
                        patternType: 'solid',
                        fgColor: { rgb: LEVEL_FILL[lv] },
                        bgColor: { rgb: LEVEL_FILL[lv] }
                    };
                    baseStyle.font = Object.assign({}, baseStyle.font || {}, LEVEL_FONT[lv]);
                    ws[addr] = Object.assign({}, old, { s: baseStyle });
                }
            }
        });
    }

    /**
     * 在 XLSX 工作表的指定单元格写入值（保留原样式）
     * 自动追加：
     *   - 细实线边框（四边）
     *   - 水平居中 + 垂直居中
     * @param {object} ws XLSX worksheet
     * @param {number} row 1-based 行号
     * @param {number} col 列号（A=1, B=2, ...）
     * @param {string} value
     */
    function setCell(ws, row, col, value) {
        if (!ws || value === undefined || value === null) return;
        var addr = global.XLSX.utils.encode_cell({ r: row - 1, c: col - 1 });
        // 保留单元格原有样式（如有）
        var old = ws[addr];
        ws[addr] = Object.assign({}, old || {}, {
            v: value,
            t: 's',
            w: String(value),
            s: buildBaseStyle(old && old.s)
        });
    }

    /**
     * 追加内容到指定单元格（同一 cell 多次写入时，用分隔符连接）
     * 用于附表2 中同一分类的多个 entry 写入同一行 B/C/D 列的场景
     * - 首次写入：直接覆盖（等价 setCell）
     * - 后续写入：若已存在非空值，用分隔符「；」追加
     * - 跳过空值/null/undefined，避免出现连续分隔符
     * @param {object} ws
     * @param {number} row 1-based 行
     * @param {number} col 1-based 列
     * @param {string} value
     * @param {string} [separator='；'] 分隔符
     */
    function appendToCell(ws, row, col, value, separator) {
        if (!ws || value === undefined || value === null) return;
        var sep = separator || '；';
        var s = String(value).trim();
        if (!s) return;  // 空内容直接跳过
        var addr = global.XLSX.utils.encode_cell({ r: row - 1, c: col - 1 });
        var old = ws[addr];
        var oldText = old && old.v ? String(old.v).trim() : '';
        var newText = oldText ? (oldText + sep + s) : s;
        ws[addr] = Object.assign({}, old || {}, {
            v: newText,
            t: 's',
            w: newText,
            s: buildBaseStyle(old && old.s)
        });
    }

    /**
     * 构造附表2 B 列文本：「机场名 天气类型 气象预报 HH-HH」
     * @param {object} risk
     * @returns {string}
     */
    function buildSheet2ColB(risk) {
        var airport = getAirportName(risk.icao);
        var weather = (risk.weatherTypes || []).join('/');
        var forecast = (risk.forecast || '').trim();
        var time = formatTimeRange(
            risk.startTime && risk.startTime.value,
            risk.endTime && risk.endTime.value
        );
        var parts = [];
        if (airport) parts.push(airport);
        if (weather) parts.push(weather);
        if (forecast) parts.push(forecast);
        if (time) parts.push(time);
        return parts.join(' ');
    }

    /**
     * 填充附表2 风险评估要点
     * 设计原则（按用户要求）：
     *   1. 严格按截图"风险评估要点"分类：每个 entry 写入时 A 列写对应的分类标签
     *   2. 无需对单元格进行合并：每个 cell 独立，每行独立
     *   3. 每条 risk 仅生成 1 个 entry（即使包含多种 weatherType）：
     *        - 以第一个 weatherType 找对应的"风险评估要点"分类
     *        - 剩余的 weatherType 仅作为补充信息（不参与归类）
     *        - B 列中按用户录入顺序展示所有 weatherType
     *   4. 每行数据仅允许输入一个机场
     *   5. 行的总数 = 风险条数（不是 weatherType 总数），从行 2 开始按用户录入顺序动态分配
     *   6. C 列「风险等级/天气分级」只显示风险等级，不再追加具体天气类型
     *
     *   列结构：
     *     A 列：风险评估要点（按首个 weatherType 找对应分类标签）
     *     B 列：危险源/潜在隐患 = "机场名 全部天气类型 预报 时段"
     *     C 列：风险等级/天气分级 = "等级"（如"3级/黄色预警"），不写天气类型
     *     D 列：影响航班/机场/区域/飞机 = "航班号起-落, ..."
     *
     * @param {object} ws XLSX worksheet（附表2）
     * @param {object[]} risks 风险数组（按用户录入顺序）
     * @param {Array} [flights] 航班数组（可选，用于 D 列匹配）
     * @returns {{filled: number, skipped: number, entries: number, byCategory: Object}}
     */
    function fillSheet2(ws, risks, flights) {
        if (!ws || !risks || !risks.length) {
            return { filled: 0, skipped: 0, entries: 0, byCategory: {} };
        }
        var flightList = flights || [];
        var entries = 0;
        var byCategory = {}; // 分类标签 -> 已写入 entry 数

        // 0) 清理模板 A11-A20 的残留内容（避免上次运行的脏数据）
        //    模板中行 11+ 偶尔会有上一次写入的旧标签，需要在每次写入前清空
        for (var cr = 11; cr <= 20; cr++) {
            var oldCell = ws['A' + cr];
            if (oldCell && oldCell.v) {
                ws['A' + cr] = Object.assign({}, oldCell, { v: '', w: '', t: 's' });
            }
        }

        // 1) 按用户录入顺序逐条处理 risk：每条 risk 仅生成 1 个 entry
        //    - 首个非空 weatherType 用于查分类
        //    - 全部 weatherType 保留用于 B 列展示
        var allEntries = [];
        for (var ri = 0; ri < risks.length; ri++) {
            var risk = risks[ri];
            var weatherTypes = (risk.weatherTypes || []).map(function (w) {
                return String(w || '').trim();
            }).filter(function (w) { return w; });

            if (!weatherTypes.length) {
                if (global.Logger) {
                    global.Logger.warn('[Aoc] 风险[' + (risk.icao || '?') + '] 无天气类型，跳过');
                }
                continue;
            }

            // 用第一个 weatherType 查分类
            var primaryType = weatherTypes[0];
            var cfg = null;
            for (var ci = 0; ci < SHEET2_ROW_CONFIG.length; ci++) {
                if (SHEET2_ROW_CONFIG[ci].match.test(primaryType)) {
                    cfg = SHEET2_ROW_CONFIG[ci];
                    break;
                }
            }
            if (!cfg) {
                if (global.Logger) {
                    global.Logger.warn('[Aoc] 风险[' + (risk.icao || '?') + '] 天气类型[' + primaryType + '] 无匹配分类，跳过');
                }
                continue;
            }
            allEntries.push({
                risk: risk,
                primaryType: primaryType,
                allTypes: weatherTypes,   // B 列展示全部
                cfg: cfg
            });
        }

        // 2) 按用户录入顺序写入：每条 risk 占独立一行
        //    严格保证"每行数据仅允许输入一个机场"
        var row = 2; // 数据起始行
        for (var ei = 0; ei < allEntries.length; ei++) {
            var entry = allEntries[ei];
            var risk = entry.risk;
            var cfg = entry.cfg;

            var airport = getAirportName(risk.icao);

            // A 列：风险评估要点（按首个 weatherType 查到的分类标签）
            setCell(ws, row, 1, cfg.label);

            // B 列：危险源/潜在隐患 = 机场 + 全部天气类型（按录入顺序） + 预报 + 时段
            var bText = airport;
            if (entry.allTypes.length) bText += ' ' + entry.allTypes.join('/');
            if (risk.forecast) bText += ' ' + String(risk.forecast).trim();
            var timeStr = formatTimeRange(
                risk.startTime && risk.startTime.value,
                risk.endTime && risk.endTime.value
            );
            if (timeStr) bText += ' ' + timeStr;
            setCell(ws, row, 2, bText);

            // C 列：风险等级/天气分级 = 仅等级（不再追加天气类型）
            setCell(ws, row, 3, formatLevel(risk.level));

            // D 列：影响航班/机场/区域/飞机
            var dText = buildAffectedFlightsText(filterFlightsForRisk(flightList, risk));
            setCell(ws, row, 4, dText);

            byCategory[cfg.label] = (byCategory[cfg.label] || 0) + 1;
            entries++;
            row++;
        }

        return {
            filled: entries,
            skipped: 0,
            entries: entries,
            byCategory: byCategory
        };
    }

    /**
     * 填充附表3 复杂天气
     * 录入顺序：先红 → 再橙 → 再黄（按用户录入顺序遍历后按等级分组，分组内保持用户录入顺序）
     * 采用顺序追加方式，不再受固定行数限制，避免容量不足导致机场丢失
     * 录入完成后做"机场数量检查"：
     *   - 期望录入的机场数（按用户录入风险涉及的唯一机场数）
     *   - 实际填入附表3 的机场数
     *   - 二者一致时通过；不一致时记录差额与跳过的机场列表
     * @param {object} ws XLSX worksheet（附表3）
     * @param {object[]} risks 风险数组（按用户录入顺序）
     * @returns {{filled: number, skipped: number, byLevel: Object, airportCheck: Object}}
     */
    function fillSheet3(ws, risks) {
        if (!ws || !risks || !risks.length) {
            return { filled: 0, skipped: 0, byLevel: { '红': 0, '橙': 0, '黄': 0 }, airportCheck: null };
        }
        var byLevel = { '红': 0, '橙': 0, '黄': 0 };
        var skipped = 0;

        // 1) 按等级分组，组内保持用户录入顺序（先到先得）
        var grouped = { '红': [], '橙': [], '黄': [] };
        for (var i = 0; i < risks.length; i++) {
            var lv = risks[i].level;
            if (grouped[lv]) grouped[lv].push(risks[i]);
        }

        // 2) 期望录入的机场清单（去重 ICAO），用于"机场数量检查"
        //    - 每条风险对应一个"机场条目"
        //    - 若同一 ICAO 出现多次（同一机场多种等级），仍按"风险条数"计
        var expectedAirports = []; // [{icao, name, level}, ...]
        for (var j = 0; j < risks.length; j++) {
            var r0 = risks[j];
            expectedAirports.push({
                icao: r0.icao || '',
                name: getAirportName(r0.icao),
                level: r0.level || ''
            });
        }

        // 3) 按等级顺序填充：红 → 橙 → 黄（顺序追加，无容量限制）
        //    行 2 为标题行，数据从行 3 开始
        var currentRow = 3;
        var levelOrder = ['红', '橙', '黄'];
        var filledAirports = []; // 实际填入的 [{icao, name, level, row}, ...]

        for (var li = 0; li < levelOrder.length; li++) {
            var lv = levelOrder[li];
            var list = grouped[lv];
            if (!list.length) continue;

            for (var k = 0; k < list.length; k++) {
                var risk = list[k];
                var airport = getAirportName(risk.icao);
                var weather = (risk.weatherTypes || []).join('/');
                var forecast = (risk.forecast || '').trim();
                var time = formatTimeRange(
                    risk.startTime && risk.startTime.value,
                    risk.endTime && risk.endTime.value
                );
                
                // 组内序号（每个等级从 1 开始）
                var seqIndex = k + 1;

                // 列结构严格按照图片模板：
                //   A 列 序号（组内递增，从1开始）
                //   B 列 机场
                //   C 列 天气类型
                //   D 列 气象预报
                //   E 列 时间段
                //   F 列 留空（不写入）
                setCell(ws, currentRow, 1, String(seqIndex));  // A 列 序号
                setCell(ws, currentRow, 2, airport);           // B 列 机场
                setCell(ws, currentRow, 3, weather);           // C 列 天气类型
                setCell(ws, currentRow, 4, forecast);          // D 列 气象预报
                setCell(ws, currentRow, 5, time);              // E 列 时间段
                
                // 直接应用等级样式（底色+字体）
                applyLevelStyleToRow(ws, currentRow, lv);
                
                byLevel[lv]++;
                filledAirports.push({
                    icao: risk.icao || '',
                    name: airport,
                    level: lv,
                    row: currentRow
                });
                currentRow++;
            }
        }

        var filled = byLevel['红'] + byLevel['橙'] + byLevel['黄'];

        // 4) 机场数量检查：期望 vs 实际
        var airportCheck = buildAirportCountCheck(expectedAirports, filledAirports, skipped, byLevel);

        return { filled: filled, skipped: skipped, byLevel: byLevel, airportCheck: airportCheck };
    }

    /**
     * 构造"机场数量检查"结果对象
     * @param {Array} expected 期望录入的机场清单（每条风险对应一项）
     * @param {Array} filled 实际填入的机场清单
     * @param {number} skipped 跳过的条数
     * @param {Object} byLevel 各等级实际填入数
     * @returns {{expected: number, filled: number, skipped: number, missing: Array, uniqueExpected: number, uniqueFilled: number, passed: boolean, byLevel: Object}}
     */
    function buildAirportCountCheck(expected, filled, skipped, byLevel) {
        var expectedUnique = {}; // icao -> 名称
        var filledUnique = {};
        var missing = []; // 期望但未填入的 ICAO 列表（去重）
        for (var i = 0; i < expected.length; i++) {
            var e = expected[i];
            if (!e || !e.icao) continue;
            expectedUnique[e.icao] = e.name || e.icao;
        }
        for (var j = 0; j < filled.length; j++) {
            var f = filled[j];
            if (!f || !f.icao) continue;
            filledUnique[f.icao] = f.name || f.icao;
        }
        for (var icao in expectedUnique) {
            if (!Object.prototype.hasOwnProperty.call(expectedUnique, icao)) continue;
            if (!filledUnique[icao]) {
                missing.push({ icao: icao, name: expectedUnique[icao] });
            }
        }
        var expectedCount = expected.length;            // 风险条数
        var filledCount = filled.length;                // 实际填入条数
        var expectedUniqueCount = Object.keys(expectedUnique).length;
        var filledUniqueCount = Object.keys(filledUnique).length;
        return {
            expected: expectedCount,        // 期望填入的"风险条数"
            filled: filledCount,            // 实际填入的"风险条数"
            skipped: skipped,               // 跳过的条数（容量满）
            missing: missing,              // 期望但未填入的机场列表
            uniqueExpected: expectedUniqueCount,  // 期望的唯一机场数
            uniqueFilled: filledUniqueCount,      // 实际填入的唯一机场数
            byLevel: byLevel,
            passed: expectedCount === filledCount
        };
    }

    /**
     * 加载模板（优先 fetch；失败时回退到内嵌 base64）
     * 加载顺序：
     *   1) fetch(TEMPLATE_URL) —— 正常路径
     *   2) window.AOC_TEMPLATE_BASE64 —— 解决 Windows / 部分浏览器 fetch 失败问题
     *      （页面为 file:// 协议、跨域限制、文件路径异常等都可能导致 fetch 抛 "Failed to fetch"）
     *   3) 全部失败 → 抛出错误
     * @returns {Promise<object>} XLSX workbook
     */
    function loadTemplate() {
        return new Promise(function (resolve, reject) {
            if (typeof global.XLSX === 'undefined') {
                reject(new Error('XLSX 库未加载'));
                return;
            }

            // 工具：把 ArrayBuffer 解析为 workbook（失败抛错）
            function parseBuffer(buf, source) {
                try {
                    return global.XLSX.read(buf, { type: 'array', cellStyles: true });
                } catch (e) {
                    throw new Error('XLSX 解析失败(' + source + '): ' + (e && e.message));
                }
            }

            // 工具：把 base64 字符串解码为 ArrayBuffer
            function base64ToArrayBuffer(b64) {
                // 兼容含换行/空格的 base64
                var clean = String(b64).replace(/[\r\n\s]/g, '');
                // 浏览器侧：atob + Uint8Array；Node 端 Buffer
                if (typeof atob !== 'undefined') {
                    var bin = atob(clean);
                    var len = bin.length;
                    var bytes = new Uint8Array(len);
                    for (var i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
                    return bytes.buffer;
                }
                // 兜底：Node Buffer 路径（仅用于测试）
                // eslint-disable-next-line no-undef
                return new Uint8Array(Buffer.from(clean, 'base64')).buffer;
            }

            // 尝试 1：fetch 远程模板
            function tryFetch() {
                if (typeof fetch === 'undefined') return Promise.reject(new Error('fetch 不可用'));
                return fetch(TEMPLATE_URL).then(function (resp) {
                    if (!resp || !resp.ok) throw new Error('HTTP ' + (resp && resp.status));
                    return resp.arrayBuffer();
                });
            }

            // 尝试 2：使用内嵌 base64
            function tryEmbedded() {
                var b64 = (typeof global.AOC_TEMPLATE_BASE64 !== 'undefined') ? global.AOC_TEMPLATE_BASE64 : null;
                if (!b64) throw new Error('未发现内嵌模板数据');
                return base64ToArrayBuffer(b64);
            }

            tryFetch()
                .then(function (buf) {
                    resolve(parseBuffer(buf, 'fetch:' + TEMPLATE_URL));
                })
                .catch(function (fetchErr) {
                    if (global.Logger) {
                        global.Logger.warn('[Aoc] 模板 fetch 失败，回退到内嵌 base64: ' + (fetchErr && fetchErr.message));
                    }
                    try {
                        var buf2 = tryEmbedded();
                        resolve(parseBuffer(buf2, 'embedded'));
                    } catch (embedErr) {
                        reject(new Error('模板加载失败（fetch 与内嵌均不可用）: ' + (fetchErr && fetchErr.message) + ' | ' + (embedErr && embedErr.message)));
                    }
                });
        });
    }

    /**
     * 写入并下载 xlsx 文件
     * @param {object} wb XLSX workbook
     * @param {string} filename
     */
    function writeAndDownload(wb, filename) {
        try {
            global.XLSX.writeFile(wb, filename);
        } catch (e) {
            // 兜底：生成 Blob + 手动下载
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
     * 触发 AOC 共享表格导出
     * 入口：global.NextDayRiskModule.getRisks()
     */
    function exportRisks() {
        var risks = (global.NextDayRiskModule && typeof global.NextDayRiskModule.getRisks === 'function')
            ? global.NextDayRiskModule.getRisks()
            : [];
        if (!risks || risks.length === 0) {
            if (global.Logger) global.Logger.warn('次日风险列表为空，未导出 AOC 共享表格');
            return;
        }
        if (typeof global.XLSX === 'undefined') {
            if (global.Logger) global.Logger.error('XLSX 库未加载，无法导出 AOC 共享表格');
            return;
        }

        var filename = FILENAME_PREFIX + getNextDayDateLabel(new Date()) + '.xlsx';

        // 加载航班数据与模板并行（航班走「缓存 → URL 回落」统一入口）
        Promise.all([
            loadTemplate(),
            loadFlightsWithCache().catch(function () { return []; })  // 航班加载失败不阻塞
        ]).then(function (results) {
            var wb = results[0];
            var flights = results[1] || [];
            var ws2 = wb.Sheets['附表2  运援'];
            var ws3 = wb.Sheets['附表3 复杂天气'];
            if (!ws2 || !ws3) {
                if (global.Logger) global.Logger.error('AOC 模板选项卡缺失（期望 附表2  运援 / 附表3 复杂天气）');
                return;
            }
            // 先解除附表3 A 列从第 3 行开始的合并区域
            // 原因：fillSheet3 需要在 A 列每行写入"序号"，无法保持合并
            unmergeSheet3ColumnA(ws3);
            // 再给模板所有单元格应用统一边框 + 居中（覆盖标题、表头、空白单元格）
            applyBaseStyle(ws2);
            applyBaseStyle(ws3);
            // 写入附表3第 2 行的标题栏：序号/机场/天气类型/气象预报/时间段
            writeSheet3TitleRow(ws3);
            // 填充数据（附表2 传入航班数组用于 D 列匹配）
            var r2 = fillSheet2(ws2, risks, flights);
            var r3 = fillSheet3(ws3, risks);
            writeAndDownload(wb, filename);
            // 附表3 机场数量检查日志：用于排查"录入 N 个机场但导出不全"
            if (r3.airportCheck) {
                var ac = r3.airportCheck;
                if (ac.passed) {
                    if (global.Logger) {
                        global.Logger.info('[Aoc] 附表3 机场数量检查通过: 期望 ' + ac.expected +
                            ' 条 / 实际 ' + ac.filled + ' 条（唯一机场 ' + ac.uniqueExpected + ' 个）');
                    }
                } else {
                    var missNames = (ac.missing || []).map(function (m) {
                        return (m && m.name) || (m && m.icao) || '?';
                    }).join('、');
                    if (global.Logger) {
                        global.Logger.warn('[Aoc] 附表3 机场数量检查未通过: 期望 ' + ac.expected +
                            ' 条 / 实际 ' + ac.filled + ' 条（跳过 ' + ac.skipped + ' 条；缺少: ' + missNames + '）');
                    }
                }
            }
            if (global.Logger) {
                global.Logger.info('导出 AOC 共享表格: ' + filename, {
                    sheet2: { filled: r2.filled, skipped: r2.skipped, fallback: r2.fallback, matchedFlights: flights.length },
                    sheet3: { filled: r3.filled, skipped: r3.skipped, byLevel: r3.byLevel, airportCheck: r3.airportCheck }
                });
            }
        }).catch(function (err) {
            if (global.Logger) global.Logger.error('AOC 共享表格导出失败', err && err.message);
            if (global.alert) {
                global.alert(err.message || 'AOC 共享表格导出失败');
            }
        });
    }

    /* ============================================================
     * UI 绑定：航班文件上传 + 缓存状态
     * ------------------------------------------------------------
     * - 上传：选择 .xls/.xlsx → 解析 → 写 chrome.storage.local → 刷新 UI
     * - 清除：清空缓存 + UI
     * - 状态文本：未上传 / 已加载 N 条 (来源：upload|url|cache) / 解析失败
     * ============================================================ */

    /** 上传相关 DOM 引用（init 时填充） */
    var uploadEls = {
        fileInput: null,    // <input type="file">
        status: null,       // 状态文本节点
        fileName: null,     // 文件名展示
        clearBtn: null      // 清除缓存按钮
    };

    /**
     * 渲染航班缓存状态到 UI
     * @param {{count: number, source: string, updatedAt: string, fileName?: string}} info
     */
    function renderUploadStatus(info) {
        var status = uploadEls.status;
        var nameEl = uploadEls.fileName;
        if (!status) return;
        if (!info || !info.count) {
            status.textContent = '尚未上传航班文件，导出时将无法识别影响航班';
            status.className = 'ndr-upload-status muted';
            if (nameEl) { nameEl.textContent = ''; nameEl.hidden = true; }
            if (uploadEls.clearBtn) uploadEls.clearBtn.hidden = true;
            return;
        }
        var srcText = info.source === 'upload' ? '手动上传' :
                      info.source === 'url' ? '本地文件' : '历史缓存';
        status.textContent = '已加载 ' + info.count + ' 条航班（来源：' + srcText + '）';
        status.className = 'ndr-upload-status ok';
        if (nameEl) {
            nameEl.textContent = info.fileName ? '· ' + info.fileName : '';
            nameEl.hidden = !info.fileName;
        }
        if (uploadEls.clearBtn) {
            // 手动上传的源才显示清除按钮（避免误清掉"url 回落"的成功结果）
            uploadEls.clearBtn.hidden = info.source !== 'upload';
        }
    }

    /**
     * 处理用户选择文件
     * @param {Event} ev
     */
    function handleFileSelect(ev) {
        var input = uploadEls.fileInput;
        if (!input) return;
        var file = input.files && input.files[0];
        if (!file) return;
        if (global.Logger) global.Logger.info('[Aoc] 用户选择航班文件: ' + file.name + ' (' + file.size + ' bytes)');
        // 解析前显示"解析中"
        if (uploadEls.status) {
            uploadEls.status.textContent = '正在解析 ' + file.name + ' …';
            uploadEls.status.className = 'ndr-upload-status pending';
        }
        parseFlightsFile(file).then(function (flights) {
            if (!flights || !flights.length) {
                if (global.Logger) global.Logger.warn('[Aoc] 上传文件解析为空，请检查 Data 选项卡');
                renderUploadStatus(null);
                if (global.alert) global.alert('文件解析失败：未在 Data 工作表中找到有效航班数据。');
                // 重置 input，允许重新选择同名文件
                if (uploadEls.fileInput) uploadEls.fileInput.value = '';
                return;
            }
            // 写缓存（标记 source='upload'）
            writeFlightsCache(flights, 'upload').then(function () {
                flightsCache.flights = flights;
                flightsCache.source = 'upload';
                flightsCache.updatedAt = new Date().toISOString();
                flightsCache.loaded = true;
                renderUploadStatus({
                    count: flights.length,
                    source: 'upload',
                    updatedAt: flightsCache.updatedAt,
                    fileName: file.name
                });
                if (global.Logger) global.Logger.info('[Aoc] 上传成功: ' + flights.length + ' 条');
            });
        });
    }

    /**
     * 处理"清除缓存"按钮
     */
    function handleClearCache() {
        clearFlightsCache().then(function () {
            flightsCache.flights = [];
            flightsCache.source = '';
            flightsCache.updatedAt = '';
            flightsCache.loaded = false;
            if (uploadEls.fileInput) uploadEls.fileInput.value = '';
            renderUploadStatus(null);
            if (global.Logger) global.Logger.info('[Aoc] 航班缓存已清除');
        });
    }

    /**
     * 初始化上传 UI：绑定文件选择 + 清除按钮 + 恢复已有缓存
     * 由 next-day-risk.js / app.js 在 DOM 就绪后调用
     */
    function initUploadUi() {
        uploadEls.fileInput = document.getElementById('ndr-flights-file');
        uploadEls.status = document.getElementById('ndr-flights-status');
        uploadEls.fileName = document.getElementById('ndr-flights-filename');
        uploadEls.clearBtn = document.getElementById('ndr-flights-clear');
        if (!uploadEls.fileInput) {
            if (global.Logger) global.Logger.warn('[Aoc] 未找到上传 UI 节点，跳过初始化');
            return;
        }
        uploadEls.fileInput.addEventListener('change', handleFileSelect);
        if (uploadEls.clearBtn) {
            uploadEls.clearBtn.addEventListener('click', handleClearCache);
        }
        // 恢复已有缓存状态（不下载文件，只显示信息）
        readFlightsCache().then(function (cached) {
            if (cached && cached.flights && cached.flights.length) {
                flightsCache.flights = cached.flights;
                flightsCache.source = cached.source || 'cache';
                flightsCache.updatedAt = cached.updatedAt || '';
                flightsCache.loaded = true;
                renderUploadStatus({
                    count: cached.flights.length,
                    source: cached.source || 'cache',
                    updatedAt: cached.updatedAt || '',
                    fileName: ''
                });
            } else {
                renderUploadStatus(null);
            }
        });
    }

    /* ============================================================
     * 暴露 API
     * ============================================================ */
    global.AocRiskShareExport = {
        exportRisks: exportRisks,
        // UI 初始化入口（DOM 就绪后调用）
        initUploadUi: initUploadUi,
        // 暴露内部纯函数，便于单元测试
        _formatTimeRange: formatTimeRange,
        _extractHour: extractHour,
        _mapWeatherToRow: mapWeatherToRow,
        _isMergedSubCell: isMergedSubCell,
        _fillSheet2: fillSheet2,
        _fillSheet3: fillSheet3,
        _getNextDayDateLabel: getNextDayDateLabel,
        _getAirportName: getAirportName,
        _buildBaseStyle: buildBaseStyle,
        _thinBorder: thinBorder,
        _applyBaseStyle: applyBaseStyle,
        _applyLevelColors: applyLevelColors,
        _unmergeSheet3ColumnA: unmergeSheet3ColumnA,
        _writeSheet3TitleRow: writeSheet3TitleRow,
        _clearFixedRowHeights: clearFixedRowHeights,
        // 等级格式化 + 航班加载/筛选/格式化
        _formatLevel: formatLevel,
        _loadFlightsFromUrl: loadFlightsFromUrl,
        _parseFlightsFile: parseFlightsFile,
        _parseFlightsWorksheet: parseFlightsWorksheet,
        _filterFlightsForRisk: filterFlightsForRisk,
        _getAirportNameCandidates: getAirportNameCandidates,
        _buildAffectedFlightsText: buildAffectedFlightsText,
        _normalizeTimeStr: normalizeTimeStr,
        // 缓存读写
        _readFlightsCache: readFlightsCache,
        _writeFlightsCache: writeFlightsCache,
        _clearFlightsCache: clearFlightsCache,
        _loadFlightsWithCache: loadFlightsWithCache,
        _loadTemplate: loadTemplate,
        _getFlightsCacheInfo: function () {
            return {
                loaded: flightsCache.loaded,
                count: flightsCache.flights.length,
                source: flightsCache.source,
                updatedAt: flightsCache.updatedAt
            };
        }
    };
})(typeof window !== 'undefined' ? window : this);
