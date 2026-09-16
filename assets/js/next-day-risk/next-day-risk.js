/**
 * 「次日风险制作」核心录入模块
 * --------------------------------------------------------------------
 * 职责
 *   - 维护 6 字段必填校验：关注等级/机场/天气类型/影响开始时间/影响结束时间/气象预报
 *   - 机场输入：仅 4 位大写字母 + 必须属于 C0039 列表（从 airports.js 提取）
 *   - 时间输入：HHMM 4 位简写 → 次日 HH:00:00；完整 yyyy/m/d HH:mm:ss → 保持
 *   - 保存按钮：6 字段全部填写 + 校验通过才启用
 *   - 数据持久化：Storage 键 met_tool_next_day_risks_v2
 *   - 暴露 global.NextDayRiskModule = { init, getRisks, clearAll }
 *
 * 依赖
 *   - airports.js: AirportTemplate.nameToIcao / getNameByIcao
 *   - storage.js:  Storage.get / set
 *   - logger.js:   Logger.info / warn / error
 */
(function (global) {
    'use strict';

    /* ============================================================
     * 常量
     * ============================================================ */

    /** 持久化键名（与 next-day-risk-excel.js / next-day-risk-word.js 共享） */
    var STORAGE_KEY = 'met_tool_next_day_risks_v2';

    /** 存档键前缀（按日期命名：met_tool_next_day_risks_v2_YYYYMMDD） */
    var ARCHIVE_KEY_PREFIX = 'met_tool_next_day_risks_v2_';
    /** 当前选中存档键 */
    var ARCHIVE_CURRENT_KEY = 'met_tool_next_day_archive_current';

    /**
     * 每日 3 个气象预报存档时段
     *   period: 存档时段标识（存储键后缀）
     *   suffix: 展示名称后缀
     *   start/end: 对应录入时间范围（HHMM 整数，含端点）
     *   0730=0000-0900、1530=0901-1630、1930=1631-2359
     * 仅 0730 为修改档（继承前一日 1530 并对既有风险做 新增/取消/升级/降级/修订）
     */
    var FORECAST_PERIODS = [
        { period: '0730', suffix: '气象预报0730', start: 0, end: 900 },
        { period: '1530', suffix: '气象预报1530', start: 901, end: 1630 },
        { period: '1930', suffix: '气象预报1930', start: 1631, end: 2359 }
    ];

    /** 时段标识 → 展示后缀映射 */
    var PERIOD_SUFFIX = {};
    FORECAST_PERIODS.forEach(function (p) { PERIOD_SUFFIX[p.period] = p.suffix; });

    /** 修改档时段标识（每日唯一） */
    var MODIFICATION_PERIOD = '0730';
    /** 旧版统一键（用于迁移） */
    var LEGACY_STORAGE_KEY = 'met_tool_next_day_risks_v2';

    /** 15 种天气类型（按 spec.md 定义） */
    var WEATHER_TYPES = [
        '低云', '低能见度', '顺风', '侧风', '大风', '风切变', '降水',
        '冰雪天气', '凝冻天气', '沙尘暴', '火山灰', '积冰', '颠簸', '雷雨', '台风'
    ];

    /** 关注等级下拉选项（与表单 option 保持一致） */
    var LEVEL_OPTIONS = [
        { value: '黄', label: '黄色预警（一般关注）' },
        { value: '橙', label: '橙色预警（中度关注）' },
        { value: '红', label: '红色预警（高度关注）' }
    ];

    /** 关注等级排序（用于判定升级/降级）：黄 < 橙 < 红 */
    var LEVEL_RANK = { '黄': 1, '橙': 2, '红': 3 };

    /** 关注等级快捷键映射（数字 → {value, label}） */
    var LEVEL_SHORTCUT = {
        '1': LEVEL_OPTIONS[0],
        '2': LEVEL_OPTIONS[1],
        '3': LEVEL_OPTIONS[2]
    };

    /** 联想最大条数 */
    var SUGGEST_LIMIT = 8;

    /* ============================================================
     * 状态
     * ============================================================ */

    /** 存档切换分段控件实例（由 SegmentedControl 创建） */
    var archiveTabsCtrl = null;

    /** 日期选择分段控件实例映射：{ 'start': ctrl, 'end': ctrl } */
    var dayTabsCtrl = {};

    /** 已录入风险列表 */
    var state = {
        risks: [],
        /** 当前正在编辑的风险 id；null = 新增模式 */
        editingId: null,
        /** 影响开始时间的日期偏移：0=当日，1=次日（默认），2=后日 */
        startDayOffset: 1,
        /** 影响结束时间的日期偏移：0=当日，1=次日（默认），2=后日 */
        endDayOffset: 1,
        /** 当前存档日期键（YYYYMMDD），默认当日 */
        currentArchiveKey: '',
        /** 是否为修改档（当前存档为 0730 时段，即继承前一日 1530 并对既有风险做修改） */
        isModArchive: false,
        /** 存档映射缓存：{ 'YYYYMMDD': [...risks] } */
        archiveStore: {}
    };

    /** DOM 元素引用 */
    var elements = {
        form: null,
        level: null,
        icao: null,
        icaoHint: null,
        suggest: null,
        weatherChips: null,
        startTime: null,
        endTime: null,
        startDayGroup: null,
        endDayGroup: null,
        forecast: null,
        error: null,
        save: null,
        reset: null,
        list: null,
        empty: null,
        count: null,
        clearAll: null,
        exportExcel: null,
        screenshot: null,
        exportAoc: null,
        // 自定义确认弹窗
        confirmModal: null,
        confirmTitle: null,
        confirmMessage: null,
        confirmOk: null,
        confirmCancel: null,
        archiveTabs: null
    };

    /** 联想浮层状态 */
    var suggestState = {
        items: [],     // 当前候选 [{name, icao}, ...]
        activeIdx: -1  // 当前键盘高亮索引
    };

    /* ============================================================
     * 存档管理器
     * ============================================================ */

    var ArchiveManager = (function () {
        /**
         * 构建存档键名
         * @param {string} dateKey
         * @returns {string}
         */
        function buildKey(dateKey) {
            return ARCHIVE_KEY_PREFIX + dateKey;
        }

        /**
         * 保存指定日期的风险数据
         * @param {string} dateKey YYYYMMDD
         * @param {Array} risks
         */
        function save(dateKey, risks) {
            try {
                if (global.Storage && typeof global.Storage.set === 'function') {
                    global.Storage.set(buildKey(dateKey), risks);
                }
            } catch (e) {
                if (global.Logger) global.Logger.error('存档保存失败', e && e.message);
            }
        }

        /**
         * 加载指定日期的风险数据
         * @param {string} dateKey YYYYMMDD
         * @returns {Array}
         */
        function load(dateKey) {
            try {
                if (global.Storage && typeof global.Storage.get === 'function') {
                    var arr = global.Storage.get(buildKey(dateKey));
                    return Array.isArray(arr) ? arr : [];
                }
            } catch (e) {
                if (global.Logger) global.Logger.error('存档加载失败', e && e.message);
            }
            return [];
        }

        /**
         * 获取有效的存档列表（仅当日 3 个气象预报时段：0730/1530/1930）
         * 前一日存档在完成复制后被清理，不再展示
         * @returns {Array<{dateKey: string, label: string, period: string, isModArchive: boolean}>}
         */
        function getValidArchives() {
            var today = getBeijingDateKey(new Date());
            return FORECAST_PERIODS.map(function (p) {
                var key = getArchiveKey(0, p.period);
                return {
                    dateKey: key,
                    label: formatDateKeyLabel(key),
                    period: p.period,
                    isModArchive: (p.period === MODIFICATION_PERIOD)
                };
            });
        }

        /**
         * 清理过期存档
         * 仅保留当日 3 个时段；其余（含已完成复制的前一日）全部清理
         */
        function pruneExpired() {
            var validKeys = {};
            var archives = getValidArchives();
            archives.forEach(function (a) { validKeys[a.dateKey] = true; });

            try {
                if (global.Storage && typeof global.Storage.get === 'function') {
                    // 遍历所有可能的存档键并清理
                    var today = new Date();
                    for (var i = -30; i <= 30; i++) {
                        var d = new Date(today.getTime() + i * 86400000);
                        var dateKey = getBeijingDateKey(d);
                        FORECAST_PERIODS.forEach(function (p) {
                            var fullArchiveKey = dateKey + '_' + p.period;
                            if (!validKeys[fullArchiveKey]) {
                                var fullKey = buildKey(fullArchiveKey);
                                try {
                                    var val = global.Storage.get(fullKey);
                                    if (val !== null && val !== undefined) {
                                        global.Storage.remove(fullKey);
                                        if (global.Logger) global.Logger.info('过期存档已清理', { dateKey: fullArchiveKey });
                                    }
                                } catch (e2) { /* ignore */ }
                            }
                        });
                    }
                }
            } catch (e) {
                if (global.Logger) global.Logger.error('过期存档清理失败', e && e.message);
            }
        }

        /**
         * 迁移旧数据（AM/PM 与旧统一键）到新的 3 时段存档（仅当目标为空时写入）
         *   旧 _AM → 新 _0730；旧 _PM → 新 _1530；旧统一键 → 当日 0730
         * 迁移完成后删除旧键
         */
        function migrateLegacy() {
            try {
                if (global.Storage && typeof global.Storage.get !== 'function') return;
                var migrated = false;
                var today = new Date();
                // 扫描近期日期，迁移旧 AM/PM 键
                for (var i = -30; i <= 30; i++) {
                    var d = new Date(today.getTime() + i * 86400000);
                    var dateKey = getBeijingDateKey(d);
                    [['AM', '0730'], ['PM', '1530']].forEach(function (pair) {
                        var oldKey = buildKey(dateKey + '_' + pair[0]);
                        var newKey = buildKey(dateKey + '_' + pair[1]);
                        try {
                            var oldVal = global.Storage.get(oldKey);
                            if (oldVal === null || oldVal === undefined) return;
                            var newVal = global.Storage.get(newKey);
                            // 仅当新键为空时才迁移，避免覆盖
                            if ((newVal === null || newVal === undefined) && Array.isArray(oldVal) && oldVal.length > 0) {
                                global.Storage.set(newKey, oldVal);
                                migrated = true;
                                if (global.Logger) global.Logger.info('旧存档已迁移', { from: dateKey + '_' + pair[0], to: dateKey + '_' + pair[1], count: oldVal.length });
                            }
                            global.Storage.remove(oldKey);
                        } catch (e2) { /* ignore */ }
                    });
                }
                // 旧统一键 → 当日 0730（仅当为空）
                var legacy = global.Storage.get(LEGACY_STORAGE_KEY);
                if (Array.isArray(legacy) && legacy.length > 0) {
                    var todayKey = getArchiveKey(0, MODIFICATION_PERIOD);
                    var existing = load(todayKey);
                    if (existing.length === 0) {
                        save(todayKey, legacy);
                        migrated = true;
                        if (global.Logger) global.Logger.info('旧数据已迁移到当日0730', { count: legacy.length });
                    }
                    try { global.Storage.remove(LEGACY_STORAGE_KEY); } catch (e2) { /* ignore */ }
                }
                if (migrated && global.Logger) global.Logger.info('旧数据迁移完成');
            } catch (e) {
                if (global.Logger) global.Logger.error('旧数据迁移失败', e && e.message);
            }
        }

        /**
         * 记录当前选中的存档
         * @param {string} archiveKey 格式：YYYYMMDD_0730/1530/1930
         */
        function setCurrent(archiveKey) {
            try {
                if (global.Storage && typeof global.Storage.set === 'function') {
                    global.Storage.set(ARCHIVE_CURRENT_KEY, archiveKey);
                }
            } catch (e) { /* ignore */ }
        }

        /**
         * 获取当前选中的存档（默认按当前北京时间所属时段）
         * @returns {string} 格式：YYYYMMDD_0730/1530/1930
         */
        function getCurrent() {
            var valid = {};
            getValidArchives().forEach(function (a) { valid[a.dateKey] = true; });
            try {
                if (global.Storage && typeof global.Storage.get === 'function') {
                    var v = global.Storage.get(ARCHIVE_CURRENT_KEY);
                    // 检查是否为有效的当日存档
                    if (v && valid[v]) return v;
                }
            } catch (e) { /* ignore */ }
            // 默认返回当前北京时间所属时段的当日存档
            return getArchiveKey(0, getPeriodByParts(getBeijingParts(new Date())));
        }

        return {
            save: save,
            load: load,
            getValidArchives: getValidArchives,
            pruneExpired: pruneExpired,
            migrateLegacy: migrateLegacy,
            setCurrent: setCurrent,
            getCurrent: getCurrent,
            buildKey: buildKey
        };
    })();

    /* ============================================================
     * 工具函数
     * ============================================================ */

    /**
     * 从 airports.js 的 NAME_TO_ICAO 提取所有合法的 4 位 ICAO 集合
     * 用于机场输入合法性校验（仅 C0039 列表内的 ICAO 可通过）
     * @returns {Object<string, boolean>}
     */
    function buildIcaoSet() {
        var set = {};
        if (global.AirportTemplate && global.AirportTemplate.nameToIcao) {
            var map = global.AirportTemplate.nameToIcao;
            for (var name in map) {
                if (Object.prototype.hasOwnProperty.call(map, name)) {
                    set[String(map[name]).toUpperCase()] = true;
                }
            }
        }
        return set;
    }

    /** C0039 ICAO 集合（模块加载时构造一次） */
    var C0039_ICAOS = buildIcaoSet();

    /**
     * 清洗机场输入：去除非字母字符 + 转大写 + 截断到 4 位
     * @param {string} value
     * @returns {string}
     */
    function sanitizeIcaoInput(value) {
        if (value == null) return '';
        return String(value).replace(/[^A-Za-z]/g, '').toUpperCase().slice(0, 4);
    }

    /**
     * 补零：不足 2 位前面补 0
     * @param {number} n
     * @returns {string}
     */
    function pad2(n) { return n < 10 ? '0' + n : '' + n; }

    /**
     * 获取北京时间的"今日"日期时间分量
     * 严格使用 UTC+8 计算当天日期（避免被用户本地时区影响）
     * @param {Date} [d] 可选基准时间
     * @returns {{y:number, m:number, d:number, hh:number, mm:number, ss:number}}
     */
    function getBeijingParts(d) {
        d = d || new Date();
        var utc = d.getTime() + (d.getTimezoneOffset() * 60000);
        var bj = new Date(utc + 3600000 * 8);
        return {
            y: bj.getFullYear(),
            m: bj.getMonth() + 1,
            d: bj.getDate(),
            hh: bj.getHours(),
            mm: bj.getMinutes(),
            ss: bj.getSeconds()
        };
    }

    /**
     * 获取北京时间的日期键（YYYYMMDD 格式）
     * @param {Date} [d] 可选基准时间
     * @returns {string}
     */
    function getBeijingDateKey(d) {
        var parts = getBeijingParts(d);
        return parts.y + pad2(parts.m) + pad2(parts.d);
    }

    /**
     * 生成指定日期偏移和时段的存档键
     * @param {number} dayOffset 相对今日的偏移（-1=前一日，0=当日）
     * @param {string} period 时段标识：'0730' / '1530' / '1930'
     * @returns {string} 格式：YYYYMMDD_0730
     */
    function getArchiveKey(dayOffset, period) {
        var today = new Date();
        var target = new Date(today.getTime() + dayOffset * 86400000);
        var dateKey = getBeijingDateKey(target);
        return dateKey + '_' + period;
    }

    /**
     * 根据时间（时/分）判断所属气象预报时段
     *   0000-0900 → 0730；0901-1630 → 1530；1631-2359 → 1930
     * @param {number} hour 小时数（0-23）
     * @param {number} [minute] 分钟数（0-59），默认 0
     * @returns {string} '0730' / '1530' / '1930'
     */
    function getPeriodByTime(hour, minute) {
        var h = (typeof hour === 'number') ? hour : 0;
        var m = (typeof minute === 'number') ? minute : 0;
        var v = h * 100 + m;
        for (var i = 0; i < FORECAST_PERIODS.length; i++) {
            var p = FORECAST_PERIODS[i];
            if (v >= p.start && v <= p.end) return p.period;
        }
        return FORECAST_PERIODS[FORECAST_PERIODS.length - 1].period; // 兜底 1930
    }

    /**
     * 根据日期时间分量判断所属时段
     * @param {{hh:number, mm:number}} parts 包含 hh / mm 字段的日期时间分量
     * @returns {string} '0730' / '1530' / '1930'
     */
    function getPeriodByParts(parts) {
        if (!parts || typeof parts.hh !== 'number') return FORECAST_PERIODS[0].period;
        return getPeriodByTime(parts.hh, parts.mm || 0);
    }

    /**
     * 根据日期时间字符串判断所属时段
     * @param {string} value "yyyy/m/d HH:mm:ss" 格式的时间字符串
     * @returns {string} '0730' / '1530' / '1930'
     */
    function getPeriodByDateTime(value) {
        var parts = parseDateTimeInputValue(value);
        if (!parts) return FORECAST_PERIODS[0].period;
        return getPeriodByParts(parts);
    }

    /**
     * 解析存档键，提取日期部分和时段
     * @param {string} archiveKey 格式：YYYYMMDD_0730
     * @returns {{ dateKey: string, period: string }}
     */
    function parseArchiveKey(archiveKey) {
        if (!archiveKey || archiveKey.length < 11) {
            return { dateKey: archiveKey || '', period: FORECAST_PERIODS[0].period };
        }
        var period = archiveKey.substring(9);
        var valid = false;
        FORECAST_PERIODS.forEach(function (p) { if (p.period === period) valid = true; });
        if (!valid) {
            return { dateKey: archiveKey, period: FORECAST_PERIODS[0].period };
        }
        return { dateKey: archiveKey.substring(0, 8), period: period };
    }

    /**
     * 格式化存档键为显示标签
     * @param {string} archiveKey 格式：YYYYMMDD_0730
     * @returns {string} 格式：MM月DD日气象预报0730
     */
    function formatDateKeyLabel(archiveKey) {
        if (!archiveKey) return archiveKey;
        var parsed = parseArchiveKey(archiveKey);
        if (!parsed.dateKey || parsed.dateKey.length !== 8) return archiveKey;
        var mm = parseInt(parsed.dateKey.substring(4, 6), 10);
        var dd = parseInt(parsed.dateKey.substring(6, 8), 10);
        var suffix = PERIOD_SUFFIX[parsed.period] || ('气象预报' + parsed.period);
        return mm + '月' + dd + '日' + suffix;
    }

    /**
     * 判断存档键是否为修改档（0730 时段）
     * @param {string} archiveKey
     * @returns {boolean}
     */
    function isModificationArchiveKey(archiveKey) {
        return parseArchiveKey(archiveKey).period === MODIFICATION_PERIOD;
    }

    /**
     * 把日期时间分量格式化为输入框字符串 "yyyy/m/d HH:mm:ss"
     * @param {{y:number, m:number, d:number, hh:number, mm:number, ss:number}} parts
     * @returns {string}
     */
    function formatDateTimeParts(parts) {
        return parts.y + '/' + parts.m + '/' + parts.d + ' ' +
            pad2(parts.hh) + ':' + pad2(parts.mm) + ':' + pad2(parts.ss);
    }

    /**
     * 给定 "yyyy/m/d HH:mm:ss" 字符串，提取日期分量；返回 null 表示解析失败
     * @param {string} value
     * @returns {{y:number, m:number, d:number, hh:number, mm:number, ss:number}|null}
     */
    function parseDateTimeInputValue(value) {
        if (!value) return null;
        var m = String(value).match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2})(?::(\d{0,2}))?$/);
        if (!m) return null;
        return {
            y: parseInt(m[1], 10),
            m: parseInt(m[2], 10),
            d: parseInt(m[3], 10),
            hh: parseInt(m[4], 10),
            mm: parseInt(m[5], 10),
            ss: (m[6] == null || m[6] === '') ? 0 : parseInt(m[6], 10)
        };
    }

    /**
     * 计算日期 +1 天的分量，自动处理跨月/跨年/补零
     * @param {{y:number, m:number, d:number}} date
     * @returns {{y:number, m:number, d:number}}
     */
    function addOneDay(date) {
        return addDays(date, 1);
    }

    /**
     * 计算日期偏移 n 天的分量，自动处理跨月/跨年/补零
     * @param {{y:number, m:number, d:number}} date
     * @param {number} n 偏移天数（1=次日，2=后日）
     * @returns {{y:number, m:number, d:number}}
     */
    function addDays(date, n) {
        var dt = new Date(date.y, date.m - 1, date.d);
        dt.setDate(dt.getDate() + n);
        return { y: dt.getFullYear(), m: dt.getMonth() + 1, d: dt.getDate() };
    }

    /**
     * 应用默认时间到开始/结束输入框
     * 默认：开始 = 目标日 06:00:00；结束 = 目标日 18:00:00
     * 目标日由日期偏移决定（startDayOffset/endDayOffset：0=当日，1=次日，2=后日）
     * 仅在输入框当前为空时填充，避免覆盖用户已输入的内容
     */
    function applyDefaultTimesIfEmpty() {
        if (!elements.startTime || !elements.endTime) return;
        var parts = getBeijingParts();
        // 开始：按 startDayOffset 偏移（0=当日，1=次日，2=后日）
        if (!elements.startTime.value) {
            var startDate = addDays(parts, state.startDayOffset);
            var startParts = Object.assign({}, parts, startDate, { hh: 6, mm: 0, ss: 0 });
            elements.startTime.value = formatDateTimeParts(startParts);
        }
        // 结束：按 endDayOffset 偏移（0=当日，1=次日，2=后日）
        if (!elements.endTime.value) {
            var endDate = addDays(parts, state.endDayOffset);
            var endParts = Object.assign({}, parts, endDate, { hh: 18, mm: 0, ss: 0 });
            elements.endTime.value = formatDateTimeParts(endParts);
        }
    }

    /**
     * 按日期偏移刷新 input 框里的时间值
     *   - 空：填入目标日（next 日后）的默认时间
     *   - 4 位简写：按目标日作为 baseDate 重新展开
     *   - 完整形式：保留时分秒，日期设为所选目标日
     *   - 其他形式：保持不变
     * @param {HTMLInputElement} input
     * @param {'start'|'end'} kind
     * @param {number} dayOffset 日期偏移（0=当日，1=次日，2=后日）
     */
    function refreshInputByState(input, kind, dayOffset) {
        if (!input) return;
        var raw = (input.value || '').trim();
        var hh = kind === 'start' ? 6 : 18;
        var target = addDays(getBeijingParts(), dayOffset);
        if (!raw) {
            // 空：填入目标日的默认时间
            input.value = formatDateTimeParts(Object.assign({}, target, { hh: hh, mm: 0, ss: 0 }));
            return;
        }
        // 1) 4 位简写：按目标日 baseDate 展开
        var m4 = raw.match(/^(\d{2})(\d{2})$/);
        if (m4) {
            var baseDateObj = new Date(target.y, target.m - 1, target.d);
            var parsed = parseTimeInput(raw, baseDateObj);
            var expanded = formatTimeForInput(parsed);
            if (expanded) input.value = expanded;
            return;
        }
        // 2) 完整形式：保留时分秒，日期设为所选目标日
        var mFull = raw.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2})(?::(\d{0,2}))?$/);
        if (mFull) {
            var ss = (mFull[6] == null || mFull[6] === '') ? '00' : mFull[6];
            input.value = target.y + '/' + target.m + '/' + target.d + ' ' + mFull[4] + ':' + mFull[5] + ':' + ss;
        }
        // 3) 其他形式：保持不变
    }

    /**
     * 选择日期偏移（当日/次日/后日）
     * @param {'start'|'end'} kind
     * @param {string|number} value 日期偏移值：0=当日，1=次日，2=后日
     */
    function selectDayOffset(kind, value) {
        var offset = parseInt(value, 10);
        if (isNaN(offset) || offset < 0 || offset > 2) return;
        if (kind === 'start') {
            state.startDayOffset = offset;
            syncDayGroup(elements.startDayGroup, offset);
            refreshInputByState(elements.startTime, 'start', offset);
            if (global.Logger) {
                global.Logger.info('次日风险开始日期偏移设置', { offset: offset });
            }
        } else {
            state.endDayOffset = offset;
            syncDayGroup(elements.endDayGroup, offset);
            refreshInputByState(elements.endTime, 'end', offset);
            if (global.Logger) {
                global.Logger.info('次日风险结束日期偏移设置', { offset: offset });
            }
        }
    }

    /**
     * 同步日期按钮组的视觉状态（高亮对应偏移的按钮）
     *  - 选中滑块由 SegmentedControl 组件负责（className .sgc-active / .sgc-track）
     *  - 禁用态保留原逻辑（内联样式），并同步组件 disabled 状态
     * @param {HTMLElement} group 按钮组容器
     * @param {number} offset 日期偏移（0=当日，1=次日，2=后日）
     */
    function syncDayGroup(group, offset) {
        if (!group) return;
        var btns = group.querySelectorAll('.ndr-day-btn');
        btns.forEach(function (btn) {
            var val = parseInt(btn.getAttribute('data-offset'), 10);
            var isActive = val === offset;
            var isDisabled = !!btn.disabled;
            // 激活类组件会管理 sgc-active；同时保留 is-active 以便向后兼容
            btn.classList.toggle('is-active', isActive);
            if (!isDisabled) {
                btn.classList.toggle('sgc-active', isActive);
            } else {
                btn.classList.remove('sgc-active');
            }
            // 先禁用过渡效果，确保内联样式不被 transition 覆盖
            btn.style.setProperty('transition', 'none', 'important');
            // 清除背景相关属性，避免冲突
            btn.style.removeProperty('background');
            btn.style.removeProperty('background-image');
            btn.style.removeProperty('background-color');
            // 清除禁用态残留属性，确保切换回启用态时样式正确
            btn.style.removeProperty('border-style');
            btn.style.removeProperty('filter');
            // 非重点：启用态下的激活颜色交给 CSS（滑块/文字），此处仅清理旧内联色
            if (isDisabled) {
                // 禁用态样式（历史存档只读模式）- 更明显的视觉区分
                btn.style.setProperty('color', '#8e8e93', 'important');
                btn.style.setProperty('background-image', 'none', 'important');
                btn.style.setProperty('border-color', 'rgba(170, 180, 200, 0.5)', 'important');
                btn.style.setProperty('border-style', 'dashed', 'important');
                btn.style.setProperty('box-shadow', 'none', 'important');
                btn.style.setProperty('font-weight', '500', 'important');
                btn.style.setProperty('opacity', '0.5', 'important');
                btn.style.setProperty('cursor', 'not-allowed', 'important');
                btn.style.setProperty('filter', 'grayscale(0.4)', 'important');
            } else {
                // 启用态：清除旧的内联色，交由 CSS 类控制
                btn.style.removeProperty('color');
                btn.style.removeProperty('background-color');
                btn.style.setProperty('background-image', 'none', 'important');
                btn.style.removeProperty('border-color');
                btn.style.removeProperty('box-shadow');
                btn.style.removeProperty('font-weight');
                btn.style.removeProperty('opacity');
                btn.style.setProperty('cursor', 'pointer', 'important');
            }
        });
        // 同步分段控件实例：滑块跟随选中项
        var ctrl = getDayGroupCtrl(group);
        if (ctrl) ctrl.syncValue(String(offset));
    }

    /**
     * 根据日期组容器获取其 SegmentedControl 实例
     * @param {HTMLElement} group
     */
    function getDayGroupCtrl(group) {
        if (!global.SegmentedControl) return null;
        return global.SegmentedControl.get(group) || null;
    }

    /**
     * 刷新日期按钮组的视觉状态（与 state.startDayOffset / state.endDayOffset 保持同步）
     * 在初始化/重置场景使用，确保按钮样式与内部状态一致
     */
    function syncDayGroups() {
        syncDayGroup(elements.startDayGroup, state.startDayOffset);
        syncDayGroup(elements.endDayGroup, state.endDayOffset);
    }

    /**
     * 解析时间输入
     *   - "0600" → baseDate + " 06:00:00"（HHMM 简写）
     *     baseDate 由调用方传入（按 +1 状态决定：未激活=当日，激活=次日）
     *   - "140000" → baseDate + " 14:00:00"（HHMMSS 6 位简写）
     *   - "06:00" / "14:30" → baseDate + " 14:30:00"（HH:MM 形式）
     *   - "14:00:00" → baseDate + " 14:00:00"（HH:MM:SS 形式）
     *   - "2026/7/20 14:00:00" → "2026/7/20 14:00:00"（完整形式，容忍双空格）
     *   - "2026/7/20 14:00" → "2026/7/20 14:00:00"（完整形式无秒，补 :00）
     *   - 其他 → 失败
     * 关键：凡是"只含时间"（HHMM/HHMMSS/HH:MM/HH:MM:SS）都按 baseDate 补齐日期，
     *       确保 +1 激活态下用户输入任何时间格式都得到正确的次日日期。
     * @param {string} value
     * @param {Date} [baseDate] 4 位简写时使用的日期基准；不传则退化为今天
     * @returns {{ok: boolean, value: string}}
     */
    function parseTimeInput(value, baseDate) {
        if (!value) return { ok: false, value: '' };
        var s = String(value).trim();

        // 工具：从 baseDate 提取日期分量
        function getBaseDateParts() {
            var ref = baseDate || new Date();
            return {
                y: ref.getFullYear(),
                mo: ref.getMonth() + 1,
                d: ref.getDate()
            };
        }

        // 1) 4 位简写 HHMM（如 "0600", "1430"）
        var m4 = s.match(/^(\d{2})(\d{2})$/);
        if (m4) {
            var hh = parseInt(m4[1], 10);
            var mm = parseInt(m4[2], 10);
            if (hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59) {
                var b1 = getBaseDateParts();
                return {
                    ok: true,
                    value: b1.y + '/' + b1.mo + '/' + b1.d + ' ' +
                        pad2(hh) + ':00:00'
                };
            }
            return { ok: false, value: '' };
        }

        // 2) 6 位简写 HHMMSS（如 "060000", "143000"）
        var m6 = s.match(/^(\d{2})(\d{2})(\d{2})$/);
        if (m6) {
            var hh6 = parseInt(m6[1], 10);
            var mm6 = parseInt(m6[2], 10);
            var ss6 = parseInt(m6[3], 10);
            if (hh6 >= 0 && hh6 <= 23 && mm6 >= 0 && mm6 <= 59 && ss6 >= 0 && ss6 <= 59) {
                var b2 = getBaseDateParts();
                return {
                    ok: true,
                    value: b2.y + '/' + b2.mo + '/' + b2.d + ' ' +
                        pad2(hh6) + ':' + pad2(mm6) + ':' + pad2(ss6)
                };
            }
            return { ok: false, value: '' };
        }

        // 3) HH:MM 形式（如 "06:00", "14:30", "9:5"）
        var mHM = s.match(/^(\d{1,2}):(\d{1,2})$/);
        if (mHM) {
            var hhHM = parseInt(mHM[1], 10);
            var mmHM = parseInt(mHM[2], 10);
            if (hhHM >= 0 && hhHM <= 23 && mmHM >= 0 && mmHM <= 59) {
                var b3 = getBaseDateParts();
                return {
                    ok: true,
                    value: b3.y + '/' + b3.mo + '/' + b3.d + ' ' +
                        pad2(hhHM) + ':' + pad2(mmHM) + ':00'
                };
            }
            return { ok: false, value: '' };
        }

        // 4) HH:MM:SS 形式（如 "14:00:00"）
        var mHMS = s.match(/^(\d{1,2}):(\d{2}):(\d{2})$/);
        if (mHMS) {
            var hhHMS = parseInt(mHMS[1], 10);
            var mmHMS = parseInt(mHMS[2], 10);
            var ssHMS = parseInt(mHMS[3], 10);
            if (hhHMS >= 0 && hhHMS <= 23 && mmHMS >= 0 && mmHMS <= 59 && ssHMS >= 0 && ssHMS <= 59) {
                var b4 = getBaseDateParts();
                return {
                    ok: true,
                    value: b4.y + '/' + b4.mo + '/' + b4.d + ' ' +
                        pad2(hhHMS) + ':' + pad2(mmHMS) + ':' + pad2(ssHMS)
                };
            }
            return { ok: false, value: '' };
        }

        // 5) 完整 yyyy/m/d HH:mm 或 yyyy/m/d HH:mm:ss（容忍任意空白）
        //    注意：必须放在 HH:MM 形式之后，因为这个正则更严格
        var mFull = s.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2})(?::(\d{0,2}))?$/);
        if (mFull) {
            var y2 = mFull[1];
            var mo2 = parseInt(mFull[2], 10);
            var d2 = parseInt(mFull[3], 10);
            var hh2 = parseInt(mFull[4], 10);
            var mm2 = parseInt(mFull[5], 10);
            var ss2 = mFull[6];
            if (hh2 < 0 || hh2 > 23 || mm2 < 0 || mm2 > 59) return { ok: false, value: '' };
            if (ss2 != null && ss2 !== '') {
                var ss2n = parseInt(ss2, 10);
                if (ss2n < 0 || ss2n > 59) return { ok: false, value: '' };
            }
            return {
                ok: true,
                value: y2 + '/' + mo2 + '/' + d2 + ' ' +
                    pad2(hh2) + ':' + pad2(mm2) + ':' + (ss2 == null || ss2 === '' ? '00' : pad2(parseInt(ss2, 10)))
            };
        }

        return { ok: false, value: '' };
    }

    /**
     * 构造今日北京时间的 Date 对象（本地时区表达，年/月/日与 getBeijingParts 一致）
     * 用于 parseTimeInput 的 baseDate
     */
    function getBeijingTodayDate() {
        var parts = getBeijingParts();
        return new Date(parts.y, parts.m - 1, parts.d);
    }

    /**
     * 根据字段类型（start / end）和对应日期偏移，返回 4 位简写应使用的日期基准
     * @param {'start'|'end'} kind
     * @returns {Date}
     */
    function getBaseDateForKind(kind) {
        var offset = kind === 'start' ? state.startDayOffset : state.endDayOffset;
        var d = getBeijingTodayDate();
        d.setDate(d.getDate() + offset);
        return d;
    }

    /**
     * 将 parseTimeInput 返回的 {ok,value} 还原为 yyyy/m/d HH:mm:ss 文本
     * 失败时返回空字符串
     * @param {{ok: boolean, value: string}} parsed
     * @returns {string}
     */
    function formatTimeForInput(parsed) {
        if (!parsed || !parsed.ok || !parsed.value) return '';
        // 解析 "yyyy/m/d HH:mm:ss"，规范化为单空格、秒补 0
        var m = String(parsed.value).match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2})(?::(\d{0,2}))?$/);
        if (!m) return '';
        var y = m[1], mo = parseInt(m[2], 10), d = parseInt(m[3], 10);
        var hh = parseInt(m[4], 10), mm = m[5];
        var ss = (m[6] == null || m[6] === '') ? '00' : m[6];
        if (ss.length < 2) ss = '0' + ss;
        return y + '/' + mo + '/' + d + ' ' + pad2(hh) + ':' + mm + ':' + ss;
    }

    /**
     * 尝试对时间输入框做"自动展开"：仅当输入能被完整解析时，才回填为 yyyy/m/d HH:mm:ss
     * 解析失败时保持原样，不清空输入框（避免破坏用户正在输入的中间状态）
     * @param {HTMLInputElement} input
     */
    function tryAutoExpandTime(input) {
        if (!input) return;
        var raw = (input.value || '').trim();
        if (!raw) return;
        // 根据 input 节点判断是 startTime / endTime，决定 baseDate（未激活=当日，激活=次日）
        var kind = (input === elements.endTime) ? 'end' : 'start';
        var baseDate = getBaseDateForKind(kind);
        var parsed = parseTimeInput(raw, baseDate);
        var expanded = formatTimeForInput(parsed);
        // 只有完整可解析时才回填；部分输入保持原样
        if (expanded && input.value !== expanded) {
            input.value = expanded;
        }
    }

    /**
     * 关注等级快捷键识别：用户键入 "1" / "2" / "3" 时立即展开为完整文字
     * 已输入完整文字时不重复展开；输入其他字符时按原样保留
     * 当用户再次输入数字（且当前值是「完整文字 + 1/2/3」）时，重新调整关注等级
     * @param {string} value
     * @returns {{value: string, changed: boolean, level: string}}
     */
    function applyLevelShortcut(value) {
        if (value == null) return { value: '', changed: false, level: '' };
        var s = String(value);

        // 1) 直接键入 "1" / "2" / "3" → 立即展开
        if (LEVEL_SHORTCUT[s]) {
            return { value: LEVEL_SHORTCUT[s].label, changed: true, level: LEVEL_SHORTCUT[s].value };
        }

        // 2) 完整文字（如「黄色预警（一般关注）」）→ 反向解析 level
        var matched = null;
        for (var i = 0; i < LEVEL_OPTIONS.length; i++) {
            if (LEVEL_OPTIONS[i].label === s.trim()) { matched = LEVEL_OPTIONS[i]; break; }
        }
        if (matched) {
            return { value: matched.label, changed: false, level: matched.value };
        }

        // 3) 「完整文字 + 数字」模式：如「黄色预警（一般关注）2」→ 重新展开为橙色
        //    满足"已显示某关注等级时再次输入数字即调整"的场景
        var keys = Object.keys(LEVEL_SHORTCUT);
        for (var j = 0; j < LEVEL_OPTIONS.length; j++) {
            var label = LEVEL_OPTIONS[j].label;
            for (var k = 0; k < keys.length; k++) {
                if (s === label + keys[k]) {
                    return {
                        value: LEVEL_SHORTCUT[keys[k]].label,
                        changed: true,
                        level: LEVEL_SHORTCUT[keys[k]].value
                    };
                }
            }
        }

        // 4) 其他 → 原样保留
        return { value: s, changed: false, level: '' };
    }

    /**
     * 构造机场联想列表
     * @param {string} query
     * @returns {Array<{name: string, icao: string}>}
     */
    function buildSuggestList(query) {
        if (!query) return [];
        var q = String(query).toUpperCase();
        var matches = [];
        // 遍历 C0039 ICAO 集合，按字母序匹配
        var icaos = Object.keys(C0039_ICAOS).sort();
        for (var i = 0; i < icaos.length; i++) {
            if (matches.length >= SUGGEST_LIMIT) break;
            if (icaos[i].indexOf(q) === 0) {
                var name = (global.AirportTemplate && global.AirportTemplate.getNameByIcao)
                    ? (global.AirportTemplate.getNameByIcao(icaos[i]) || icaos[i])
                    : icaos[i];
                matches.push({ name: name, icao: icaos[i] });
            }
        }
        return matches;
    }

    /**
     * 渲染联想浮层
     * @param {Array<{name: string, icao: string}>} items
     */
    function renderSuggest(items) {
        var ul = elements.suggest;
        if (!ul) return;
        if (!items || items.length === 0) {
            ul.innerHTML = '<li class="ndr-suggest-empty">无匹配机场</li>';
            ul.hidden = false;
            suggestState.items = [];
            suggestState.activeIdx = -1;
            return;
        }
        ul.innerHTML = '';
        items.forEach(function (it, idx) {
            var li = document.createElement('li');
            li.className = 'ndr-suggest-item';
            li.setAttribute('data-icao', it.icao);
            li.setAttribute('data-idx', String(idx));
            var nameSpan = document.createElement('span');
            nameSpan.className = 'name';
            nameSpan.textContent = it.name;
            var icaoSpan = document.createElement('span');
            icaoSpan.className = 'icao';
            icaoSpan.textContent = it.icao;
            li.appendChild(nameSpan);
            li.appendChild(icaoSpan);
            li.addEventListener('mousedown', function (e) {
                e.preventDefault();
                selectSuggestByIndex(idx);
            });
            li.addEventListener('mouseenter', function () {
                setSuggestActive(idx);
            });
            ul.appendChild(li);
        });
        ul.hidden = false;
        suggestState.items = items;
        suggestState.activeIdx = -1;
    }

    function hideSuggest() {
        if (elements.suggest) elements.suggest.hidden = true;
        suggestState.items = [];
        suggestState.activeIdx = -1;
    }

    function setSuggestActive(idx) {
        var ul = elements.suggest;
        if (!ul) return;
        var items = ul.querySelectorAll('.ndr-suggest-item');
        for (var i = 0; i < items.length; i++) {
            if (i === idx) items[i].classList.add('active');
            else items[i].classList.remove('active');
        }
        suggestState.activeIdx = idx;
    }

    /**
     * 选中第 idx 个候选项并回填到输入框
     * @param {number} idx
     */
    function selectSuggestByIndex(idx) {
        var item = suggestState.items[idx];
        if (!item) return;
        if (elements.icao) {
            elements.icao.value = item.icao;
            // 触发一次 icao 的 input 事件，让 hint 与 save 按钮同步
            var ev = new Event('input', { bubbles: true });
            elements.icao.dispatchEvent(ev);
        }
        hideSuggest();
        if (elements.icaoHint) {
            elements.icaoHint.textContent = '✓ 已识别：' + item.name;
            elements.icaoHint.className = 'ndr-hint ok';
            elements.icaoHint.hidden = false;
        }
    }

    /**
     * 读取当前表单状态
     * @returns {{
     *   level: string,
     *   icao: string,
     *   weatherTypes: string[],
     *   startTime: {ok: boolean, value: string},
     *   endTime: {ok: boolean, value: string},
     *   forecast: string
     * }}
     */
    function getRiskState() {
        var form = elements.form;
        var weatherSelected = Array.prototype.slice.call(
            document.querySelectorAll('.ndr-chip.active')
        ).map(function (el) { return el.getAttribute('data-value'); });
        // 关注等级：先做快捷键识别，提取内部 value
        // 使用 elements.* 而非 form.* 访问，避免对 form.name 旧行为的依赖
        var lv = applyLevelShortcut((elements.level && elements.level.value) || '');
        // startTime / endTime 4 位简写：根据各自 +1 状态决定 baseDate
        var startBase = getBaseDateForKind('start');
        var endBase = getBaseDateForKind('end');
        return {
            level: lv.level,
            icao: sanitizeIcaoInput((elements.icao && elements.icao.value) || ''),
            weatherTypes: weatherSelected,
            startTime: parseTimeInput((elements.startTime && elements.startTime.value) || '', startBase),
            endTime: parseTimeInput((elements.endTime && elements.endTime.value) || '', endBase),
            forecast: ((elements.forecast && elements.forecast.value) || '').trim()
        };
    }

    /**
     * 比较 two 个 "yyyy/m/d HH:mm:ss" 形式的时间值先后
     *   - 必须按日期/时间分量【数值比较】，不能用字符串比较：
     *     字符串比较会把 "2026/9/10" 判为小于 "2026/9/9"（'1' < '9'）
     *   - 解析失败（格式异常）返回 null，由调用方决定是否跳过校验
     * @param {string} a
     * @param {string} b
     * @returns {number|null} a>b → 1，a<b → -1，相等 → 0，解析失败 → null
     */
    function compareDateTimeValues(a, b) {
        function parseParts(v) {
            var m = String(v).match(
                /^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/
            );
            if (!m) return null;
            return {
                y: parseInt(m[1], 10),
                mo: parseInt(m[2], 10),
                d: parseInt(m[3], 10),
                h: m[4] != null ? parseInt(m[4], 10) : 0,
                mi: m[5] != null ? parseInt(m[5], 10) : 0,
                s: m[6] != null ? parseInt(m[6], 10) : 0
            };
        }
        var pa = parseParts(a);
        var pb = parseParts(b);
        if (!pa || !pb) return null;
        // 逐分量比较：年 → 月 → 日 → 时 → 分 → 秒
        var keys = ['y', 'mo', 'd', 'h', 'mi', 's'];
        for (var i = 0; i < keys.length; i++) {
            var k = keys[i];
            if (pa[k] !== pb[k]) return pa[k] > pb[k] ? 1 : -1;
        }
        return 0;
    }

    /**
     * 校验风险状态：返回缺失/非法字段的中文名数组
     * @param {object} state
     * @returns {string[]}
     */
    function validateRisk(state) {
        var missing = [];
        if (!state.level) missing.push('关注等级');
        if (!state.icao) {
            missing.push('机场（ICAO）');
        } else if (!C0039_ICAOS[state.icao]) {
            missing.push('机场（不在 C0039 列表中）');
        }
        if (state.weatherTypes.length === 0) missing.push('天气类型');
        if (!state.startTime.ok) {
            missing.push('影响开始时间（格式: HHMM 或 yyyy/m/d HH:mm:ss）');
        }
        if (!state.endTime.ok) {
            missing.push('影响结束时间（格式: HHMM 或 yyyy/m/d HH:mm:ss）');
        }
        // 起止时间逻辑校验：结束必须 ≥ 开始（按时间分量数值比较，严禁字符串比较）
        if (state.startTime.ok && state.endTime.ok) {
            var cmp = compareDateTimeValues(state.endTime.value, state.startTime.value);
            // 仅当两者均可解析且结束早于开始时报错；格式异常交由上方格式校验兜底
            if (cmp !== null && cmp < 0) {
                missing.push('结束时间不能早于开始时间');
            }
        }
        if (!state.forecast) missing.push('气象预报');
        return missing;
    }

    /* ============================================================
     * 渲染
     * ============================================================ */

    /**
     * 渲染天气类型 chip 多选控件
     */
    function renderWeatherChips() {
        var container = elements.weatherChips;
        if (!container) return;
        container.innerHTML = '';
        WEATHER_TYPES.forEach(function (w) {
            var chip = document.createElement('button');
            chip.type = 'button';
            chip.className = 'ndr-chip';
            chip.setAttribute('data-value', w);
            chip.textContent = w;
            chip.addEventListener('click', function () {
                chip.classList.toggle('active');
                updateSaveButtonState();
            });
            container.appendChild(chip);
        });
    }

    /**
     * 渲染存档切换器 Tab
     * 根据 ArchiveManager.getValidArchives() 生成当日 3 个时段 Tab（今日气象预报0730/1530/1930）
     * @param {string} activeKey 当前选中的存档键（YYYYMMDD_0730/1530/1930）
     */
    function renderArchiveTabs(activeKey) {
        if (!elements.archiveTabs) return;
        elements.archiveTabs.innerHTML = '';
        // 复用分段控件组件容器样式（滑块/弹性动画由 SegmentedControl 提供）
        elements.archiveTabs.classList.add('sgc');

        // 分段控件滑动滑块层（Apple 风格，由 SegmentedControl 定位）
        var track = document.createElement('div');
        track.className = 'sgc-track ndr-archive-track';
        elements.archiveTabs.appendChild(track);

        var archives = ArchiveManager.getValidArchives();
        archives.forEach(function (arch) {
            var tab = document.createElement('button');
            tab.type = 'button';
            tab.className = 'ndr-archive-tab sgc-item';
            tab.setAttribute('data-archive-key', arch.dateKey);
            tab.setAttribute('data-sgc-value', arch.dateKey);
            tab.textContent = arch.label;
            if (arch.dateKey === activeKey) {
                tab.classList.add('is-active', 'sgc-active');
            }
            elements.archiveTabs.appendChild(tab);
        });

        // 接入分段控件实例（负责滑块定位 + 激活态 + 选择回调）
        bindArchiveTabsControl();

        // 应用内联样式确保视觉状态正确（避免 CSS transition 覆盖）
        syncArchiveTabStyles();
    }

    /**
     * 为存档 Tab 创建 SegmentedControl 实例
     *  - 交给组件统一管理滑块（.sgc-track）与激活态（.sgc-item.sgc-active）
     *  - onChange 回调触发 switchArchive（切换存档）
     *  - 注意：本模块每次 renderArchiveTabs 都会 innerHTML 重建 DOM，
     *    因此每次都需重建实例（旧的 items/事件已随 DOM 一起销毁）。
     */
    function bindArchiveTabsControl() {
        if (!elements.archiveTabs || !global.SegmentedControl) return;
        var ctrl = new global.SegmentedControl(elements.archiveTabs, {
            name: 'archivePeriod',
            onChange: function (value) {
                if (value && value !== state.currentArchiveKey) {
                    switchArchive(value);
                }
            }
        });
        archiveTabsCtrl = ctrl;
        // 同步当前激活的存档：初始化定位滑块（不触发 onChange）
        if (state.currentArchiveKey) ctrl.syncValue(state.currentArchiveKey);
    }

    /**
     * 为开始/结束时间的日期选择组创建 SegmentedControl 实例
     *  - 每组含「当日/次日/后日」三个选项，点击触发 selectDayOffset
     *  - data-sgc-init 已在 HTML 中指定默认「次日（1）」
     *  - 注意：组件会接管选中态（滑块），但禁用态仍需通过 syncDayGroup 控制
     */
    function bindDayGroupControls() {
        var groups = [
            { kind: 'start', el: elements.startDayGroup },
            { kind: 'end', el: elements.endDayGroup }
        ];
        groups.forEach(function (g) {
            if (!g.el || !global.SegmentedControl) return;
            var ctrl = new global.SegmentedControl(g.el, {
                name: 'dayOffset_' + g.kind,
                onChange: function (value, index, item) {
                    // 历史存档只读模式（按钮已禁用）时不处理切换
                    if (item && item.disabled) return;
                    selectDayOffset(g.kind, value);
                    updateSaveButtonState();
                }
            });
            dayTabsCtrl[g.kind] = ctrl;
        });
    }

    /**
     * 更新存档 Tab 的激活状态（不重新渲染，仅更新类和样式）
     */
    function updateArchiveTabsActive() {
        if (!elements.archiveTabs) return;
        var tabs = elements.archiveTabs.querySelectorAll('.ndr-archive-tab');
        tabs.forEach(function (tab) {
            var archiveKey = tab.getAttribute('data-archive-key');
            if (archiveKey === state.currentArchiveKey) {
                tab.classList.add('is-active', 'sgc-active');
            } else {
                tab.classList.remove('is-active', 'sgc-active');
            }
        });
        // 同步分段控件滑块位置
        if (global.SegmentedControl && state.currentArchiveKey) {
            var ctrl = global.SegmentedControl.get(elements.archiveTabs);
            if (ctrl) ctrl.syncValue(state.currentArchiveKey);
        }
        // 同步样式
        syncArchiveTabStyles();
    }

    /**
     * 清除存档 Tab 的内联样式（让 CSS 类样式生效）
     * @param {HTMLElement} tab Tab 元素
     */
    function applyArchiveTabStyle(tab) {
        if (!tab) return;
        // 清除所有内联样式，让 CSS 类样式生效
        var inlineProps = [
            'color', 'background-color', 'background', 'background-image',
            'border', 'border-color', 'box-shadow', 'transition',
            'transform', 'font-weight', 'opacity', 'cursor', 'pointer-events'
        ];
        inlineProps.forEach(function (prop) {
            tab.style.removeProperty(prop);
            tab.style.removeProperty(prop.charAt(0).toUpperCase() + prop.slice(1)); // 移除驼峰写法
        });
        // 清除所有带 !important 的内联样式
        var style = tab.getAttribute('style');
        if (style) {
            // 重新设置空的 style 属性，移除所有内联样式
            tab.removeAttribute('style');
        }
    }

    /**
     * 清除所有存档 Tab 的内联样式
     */
    function syncArchiveTabStyles() {
        var tabs = document.querySelectorAll('.ndr-archive-tab');
        tabs.forEach(applyArchiveTabStyle);
    }

    /**
     * 渲染已录入风险列表
     */
    function renderRisks() {
        var list = elements.list;
        var empty = elements.empty;
        if (!list) return;

        list.innerHTML = '';
        if (state.risks.length === 0) {
            if (empty) empty.hidden = false;
            if (elements.count) elements.count.textContent = '0';
            if (elements.clearAll) {
                elements.clearAll.disabled = true;
                elements.clearAll.textContent = '全部清空';
            }
            return;
        }
        if (empty) empty.hidden = true;
        if (elements.count) elements.count.textContent = String(state.risks.length);
        if (elements.clearAll) {
            elements.clearAll.disabled = false;
            elements.clearAll.textContent = '全部清空 (' + state.risks.length + ')';
        }

        // 扑克牌样式：每张卡片为 1 个 div，水平层叠 + 倾斜效果由 CSS 实现
        state.risks.forEach(function (r, idx) {
            var card = document.createElement('div');
            card.className = 'ndr-card ndr-playing-card level-' + levelToBadgeClass(r.level);
            card.setAttribute('data-id', r.id);
            card.setAttribute('data-index', String(idx));

            // 花色/等级大字符（扑克牌的左上角）
            var levelText = levelToText(r.level);
            var levelShort = (levelText || '').charAt(0) || '?';
            var levelBig = (levelText || '').indexOf('（') > 0
                ? (levelText || '').substring(0, (levelText || '').indexOf('（'))
                : (levelText || '');

            // 顶部：No.序号 + 等级花色大字符
            var top = document.createElement('div');
            top.className = 'ndr-card-corner ndr-card-top';
            top.innerHTML =
                '<span class="ndr-card-no">No.' + String(idx + 1).padStart(2, '0') + '</span>' +
                '<span class="ndr-card-suit ' + levelToBadgeClass(r.level) + '">' +
                    escapeHtml(levelShort) +
                '</span>';

            // 中央：机场名 + ICAO（扑克牌中部的图案位置）
            var middle = document.createElement('div');
            middle.className = 'ndr-card-center';
            var nameSpan = document.createElement('div');
            nameSpan.className = 'ndr-card-airport';
            nameSpan.textContent = (global.AirportTemplate && global.AirportTemplate.getNameByIcao)
                ? (global.AirportTemplate.getNameByIcao(r.icao) || r.icao || '?')
                : (r.icao || '?');
            var icaoSpan = document.createElement('div');
            icaoSpan.className = 'ndr-card-icao';
            icaoSpan.textContent = r.icao || '';
            var levelSpan = document.createElement('div');
            levelSpan.className = 'ndr-card-level-name ' + levelToBadgeClass(r.level);
            levelSpan.textContent = levelBig + (levelText.indexOf('（') > 0 ? levelText.substring(levelText.indexOf('（')) : '');
            middle.appendChild(nameSpan);
            middle.appendChild(icaoSpan);
            middle.appendChild(levelSpan);

            // 分隔
            var sep = document.createElement('div');
            sep.className = 'ndr-card-sep';

            // 底部信息：时段 + 天气类型 chip + 预报
            var bottom = document.createElement('div');
            bottom.className = 'ndr-card-bottom';

            // 时段
            var timeBlock = document.createElement('div');
            timeBlock.className = 'ndr-card-time';
            timeBlock.innerHTML =
                '<span class="time-label">时段</span>' +
                '<span class="time-range">' +
                    escapeHtml((r.startTime && r.startTime.value) || '-') +
                    ' ~<br/>' +
                    escapeHtml((r.endTime && r.endTime.value) || '-') +
                '</span>';

            // 天气类型 chip
            var weatherBlock = document.createElement('div');
            weatherBlock.className = 'ndr-card-weather';
            var chips = document.createElement('div');
            chips.className = 'ndr-weather-chip-list';
            var types = r.weatherTypes || [];
            if (types.length === 0) {
                var none = document.createElement('span');
                none.className = 'ndr-weather-chip none';
                none.textContent = '—';
                chips.appendChild(none);
            } else {
                types.forEach(function (t) {
                    var c = document.createElement('span');
                    c.className = 'ndr-weather-chip';
                    c.textContent = t;
                    chips.appendChild(c);
                });
            }
            weatherBlock.appendChild(chips);

            // 预报
            var forecast = document.createElement('div');
            forecast.className = 'ndr-card-forecast';
            forecast.textContent = r.forecast || '';

            bottom.appendChild(timeBlock);
            bottom.appendChild(weatherBlock);
            bottom.appendChild(forecast);

            // 右下：等级花色大字符（与左上呼应，扑克牌传统布局）
            var bottomCorner = document.createElement('div');
            bottomCorner.className = 'ndr-card-corner ndr-card-bottom-corner';
            bottomCorner.innerHTML =
                '<span class="ndr-card-suit ' + levelToBadgeClass(r.level) + '">' +
                    escapeHtml(levelShort) +
                '</span>';

            // 操作：还原（历史存档 + 有操作前快照的卡片）+ 删除按钮（悬停时显示）
            var actions = document.createElement('div');
            actions.className = 'ndr-card-actions';

            // 还原按钮：删除/修订/升级/降级后出现，恢复到操作前状态
            if (state.isModArchive && r.backup) {
                var restore = document.createElement('button');
                restore.type = 'button';
                restore.className = 'btn small ghost';
                restore.textContent = '还原';
                restore.setAttribute('aria-label', '还原 ' + (r.icao || ''));
                restore.addEventListener('click', function (e) {
                    e.stopPropagation();
                    restoreRisk(r.id);
                });
                actions.appendChild(restore);
            }

            var del = document.createElement('button');
            del.type = 'button';
            del.className = 'btn small ghost';
            del.textContent = '删除';
            del.setAttribute('aria-label', '删除 ' + (r.icao || ''));
            del.addEventListener('click', function (e) {
                e.stopPropagation();
                removeRisk(r.id);
            });
            actions.appendChild(del);

            // 卡片点击 → 回填到表单，进入编辑模式
            // 通过 data-id 让 updateFormModeUi 能正确高亮当前编辑项
            card.setAttribute('role', 'button');
            card.setAttribute('tabindex', '0');
            card.setAttribute('title', '点击编辑此风险');
            card.addEventListener('click', function (e) {
                // 删除按钮的事件已 stopPropagation，不会冒泡到这里
                fillFormFromRisk(r);
            });
            card.addEventListener('keydown', function (e) {
                // 键盘可达性：Enter / Space 触发编辑
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    fillFormFromRisk(r);
                }
            });

            card.appendChild(top);
            card.appendChild(middle);
            card.appendChild(sep);
            card.appendChild(bottom);
            card.appendChild(bottomCorner);

            // 水印渲染（仅历史存档 + 有 modType 的卡片）
            if (state.isModArchive && r.modType) {
                // 兼容旧数据：'取消' 统一展示为 '删除'
                var modLabel = r.modType === '取消' ? '删除' : r.modType;
                var watermark = document.createElement('div');
                watermark.className = 'ndr-card-watermark ndr-card-watermark-' + (r.modType || 'default');
                watermark.textContent = modLabel;
                card.appendChild(watermark);

                // 删除状态 → 灰底
                if (r.modType === '取消' || r.modType === '删除') {
                    card.classList.add('is-canceled');
                }
            }

            card.appendChild(actions);
            list.appendChild(card);
        });

        // 重新同步编辑高亮（删除/新增后保持一致）
        updateFormModeUi();
    }

    /**
     * 等级 → 文字（用于徽章）
     * @param {string} level
     * @returns {string}
     */
    function levelToText(level) {
        var map = { '黄': '黄色（一般关注）', '橙': '橙色（中度关注）', '红': '红色（高度关注）' };
        return map[level] || level || '';
    }

    /**
     * 等级 → 徽章 class（high / mid / low）
     * @param {string} level
     * @returns {string}
     */
    function levelToBadgeClass(level) {
        if (level === '红') return 'high';
        if (level === '橙') return 'mid';
        return 'low';
    }

    /**
     * 简单 HTML 转义（仅用于文本节点）
     * @param {string} s
     * @returns {string}
     */
    function escapeHtml(s) {
        if (s == null) return '';
        return String(s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    /* ============================================================
     * 状态变更
     * ============================================================ */

    /**
     * 更新保存按钮启用/禁用状态
     * 仅当 6 字段全部填写 + 校验通过时启用
     * 同时显示/隐藏错误提示
     */
    function updateSaveButtonState() {
        var st = getRiskState();
        var missing = validateRisk(st);
        // 允许在任何存档（含前一日）下新增/编辑风险，保存按钮可用性仅取决于字段是否齐全
        var disabled = missing.length > 0;
        if (elements.save) elements.save.disabled = disabled;
        if (elements.error) {
            if (missing.length > 0) {
                elements.error.textContent = '请检查：' + missing.join('、');
                elements.error.hidden = false;
            } else {
                elements.error.textContent = '';
                elements.error.hidden = true;
            }
        }
    }

    /**
     * 更新导出按钮启用/禁用状态
     * 列表为空时全部禁用
     */
    function updateExportButtonState() {
        var has = state.risks.length > 0;
        if (elements.exportExcel) {
            elements.exportExcel.disabled = !has;
            if (has) elements.exportExcel.removeAttribute('disabled');
        }
        if (elements.screenshot) {
            elements.screenshot.disabled = !has;
            if (has) elements.screenshot.removeAttribute('disabled');
        }
        if (elements.exportAoc) {
            elements.exportAoc.disabled = !has;
            if (has) elements.exportAoc.removeAttribute('disabled');
        }
    }

    /**
     * 判定修改类型（仅前一日存档使用）
     * @param {Object|null} oldRisk 修改前的风险（新增时为 null）
     * @param {Object} newRisk 修改后的风险
     * @param {boolean} isNew 是否为新增模式
     * @returns {string|null} .modType 标识：新增/升级/降级/修订/null
     */
    function determineModificationType(oldRisk, newRisk, isNew) {
        if (!state.isModArchive) return null;

        // 新增：首次创建或 ICAO 变更
        if (isNew || !oldRisk) return '新增';
        if (oldRisk.icao !== newRisk.icao) return '新增';

        // ICAO 不变，比较等级变化
        var oldRank = LEVEL_RANK[oldRisk.level] || 0;
        var newRank = LEVEL_RANK[newRisk.level] || 0;

        if (newRank > oldRank) return '升级';
        if (newRank < oldRank) return '降级';

        // 等级不变，检查其他字段变化
        var otherChanged = false;
        if (oldRisk.forecast !== newRisk.forecast) otherChanged = true;
        if (oldRisk.startTime && newRisk.startTime) {
            if (oldRisk.startTime.value !== newRisk.startTime.value) otherChanged = true;
        }
        if (oldRisk.endTime && newRisk.endTime) {
            if (oldRisk.endTime.value !== newRisk.endTime.value) otherChanged = true;
        }
        // 比较天气类型
        var oldWx = (oldRisk.weatherTypes || []).join(',');
        var newWx = (newRisk.weatherTypes || []).join(',');
        if (oldWx !== newWx) otherChanged = true;

        return otherChanged ? '修订' : null;
    }

    /**
     * 生成风险条目的原状快照（清理 modType / isNew / backup 等标记字段）
     * 用于「还原」时恢复到操作前状态
     * @param {Object} r 原风险条目
     * @returns {Object}
     */
    function snapshotRisk(r) {
        if (!r) return null;
        return {
            id: r.id,
            level: r.level,
            icao: r.icao,
            weatherTypes: (r.weatherTypes || []).slice(),
            startTime: r.startTime ? { ok: true, value: r.startTime.value } : { ok: false, value: '' },
            endTime: r.endTime ? { ok: true, value: r.endTime.value } : { ok: false, value: '' },
            forecast: r.forecast || '',
            ts: r.ts || Date.now(),
            modType: null,
            isNew: undefined,
            backup: null
        };
    }

    /**
     * 保存当前表单为一条新风险 / 更新一条已存在风险
     * 根据 state.editingId 判定：
     *   - editingId = null → 新增模式，追加到列表末尾
     *   - editingId != null → 更新模式，原地替换该 id 的条目（保持原序号）
     */
    function addRisk() {
        var st = getRiskState();
        var missing = validateRisk(st);
        if (missing.length > 0) {
            if (global.Logger) global.Logger.warn('次日风险保存失败：' + missing.join('、'));
            return false;
        }

        if (state.editingId) {
            // 更新模式：按 id 查找并原地替换（保持列表中的位置）
            var idx = -1;
            for (var i = 0; i < state.risks.length; i++) {
                if (state.risks[i].id === state.editingId) { idx = i; break; }
            }
            if (idx >= 0) {
                var old = state.risks[idx];
                // 是否为"由用户新增"的风险：即使再次编辑仍视为新增，删除时直接移除卡片
                var isUserAdded = old.isNew === true || old.modType === '新增';
                // 修改标签（新增/升级/降级/修订）仅在 0730 修改档中显示；
                // 其他存档（1530/1930）的编辑为普通原地更新，不标记
                var isModArchive = state.isModArchive;
                var modType = null;
                if (isModArchive) {
                    if (isUserAdded) {
                        modType = '新增';
                    } else {
                        modType = determineModificationType(old, {
                            level: st.level,
                            icao: st.icao,
                            weatherTypes: st.weatherTypes.slice(),
                            startTime: { ok: true, value: st.startTime.value },
                            endTime: { ok: true, value: st.endTime.value },
                            forecast: st.forecast,
                            ts: Date.now()
                        }, false);
                    }
                }
                // 既有风险首次修改：保存原状快照，供「还原」恢复到操作前状态
                // 仅在确有变更（modType 非空）时生成，避免无变更保存也出现还原按钮
                var backup = null;
                if (isModArchive && !isUserAdded && modType) {
                    backup = old.backup || snapshotRisk(old);
                }

                state.risks[idx] = {
                    id: old.id,
                    level: st.level,
                    icao: st.icao,
                    weatherTypes: st.weatherTypes.slice(),
                    startTime: { ok: true, value: st.startTime.value },
                    endTime: { ok: true, value: st.endTime.value },
                    forecast: st.forecast,
                    ts: Date.now(),
                    modType: modType,
                    isNew: isModArchive ? (isUserAdded || undefined) : undefined,
                    backup: backup
                };
                persistRisks();
                renderRisks();
                updateExportButtonState();
                if (global.Logger) {
                    global.Logger.info('次日风险已更新', {
                        id: old.id, icao: state.risks[idx].icao,
                        level: state.risks[idx].level,
                        modType: modType
                    });
                }
            } else {
                // 找不到原条目（已被删除等异常情况）→ 回退为新增
                state.editingId = null;
                return addRisk();
            }
        } else {
            // 新增模式
            // 无论当前选中哪个存档，一律按「保存按钮点击时刻」对应的时段归档：
            //   1) 计算当前北京时间所属时段（0730/1530/1930）与当日存档键
            //   2) 若当前不在该存档，先持久化当前存档，再自动跳转到目标存档
            //   3) 「新增」标签仅在 0730 修改档显示（路由到 1530/1930 时为普通记录）
            var nowParts = getBeijingParts(new Date());
            var savePeriod = getPeriodByParts(nowParts);
            var newArchiveKey = getArchiveKey(0, savePeriod);
            var targetArchiveKey = newArchiveKey;

            // 当前不在目标存档时：先持久化当前存档，再切换到当前时刻对应的新存档
            if (state.currentArchiveKey !== newArchiveKey) {
                ArchiveManager.save(state.currentArchiveKey, state.risks);
                state.currentArchiveKey = newArchiveKey;
                state.isModArchive = isModificationArchiveKey(newArchiveKey);
                ArchiveManager.setCurrent(newArchiveKey);
                // 切到 0730 修改档时确保已继承前一日 1530（幂等：已有内容则跳过）
                if (state.isModArchive) ensureModArchiveCopy();
                var arr = ArchiveManager.load(newArchiveKey);
                state.risks = Array.isArray(arr) ? arr : [];
                state.archiveStore[newArchiveKey] = state.risks.slice();
                // 重新应用存档视图限制（禁用态等），与 switchArchive 保持一致
                applyArchiveViewRestrictions();
            }

            var risk = {
                id: 'r_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
                level: st.level,
                icao: st.icao,
                weatherTypes: st.weatherTypes.slice(),
                startTime: { ok: true, value: st.startTime.value },
                endTime: { ok: true, value: st.endTime.value },
                forecast: st.forecast,
                ts: Date.now(),
                // 「新增」标签仅在 0730 修改档显示；路由到 1530/1930 时为普通记录，不标记
                modType: state.isModArchive ? '新增' : null,
                isNew: state.isModArchive ? true : undefined,
                backup: null
            };
            state.risks.push(risk);
            persistRisks();
            renderRisks();
            updateExportButtonState();
            updateArchiveTabsActive();
            if (global.Logger) {
                global.Logger.info('次日风险已保存', {
                    icao: risk.icao, level: risk.level,
                    weather: risk.weatherTypes.join(','),
                    archiveKey: targetArchiveKey,
                    modType: risk.modType,
                    total: state.risks.length
                });
            }
        }
        // 退出编辑态
        state.editingId = null;
        updateFormModeUi();
        resetForm();
        // 保存成功后清空影响开始/结束时间输入框（resetForm 会重新填入默认时间，此处覆盖清空）
        if (elements.startTime) elements.startTime.value = '';
        if (elements.endTime) elements.endTime.value = '';
        return true;
    }

    /**
     * 删除指定 id 的风险
     * @param {string} id
     */
    function removeRisk(id) {
        var idx = -1;
        for (var i = 0; i < state.risks.length; i++) {
            if (state.risks[i].id === id) { idx = i; break; }
        }
        if (idx === -1) return;

        // 历史存档下的删除 → 软删除（标记为删除）
        if (state.isModArchive) {
            var r = state.risks[idx];
            // 新增标识的风险机场：直接移除卡片（无需标记删除标签、无需备份）
            if (r.isNew === true || r.modType === '新增') {
                state.risks.splice(idx, 1);
                // 若删除的正是当前正在编辑的项，退出编辑态并清空表单
                if (state.editingId === id) {
                    state.editingId = null;
                    if (elements.form) {
                        if (elements.level) elements.level.value = '';
                        if (elements.icao) elements.icao.value = '';
                        if (elements.startTime) elements.startTime.value = '';
                        if (elements.endTime) elements.endTime.value = '';
                        if (elements.forecast) elements.forecast.value = '';
                        var nchips = document.querySelectorAll('.ndr-chip.active');
                        Array.prototype.forEach.call(nchips, function (c) { c.classList.remove('active'); });
                        if (elements.icaoHint) elements.icaoHint.hidden = true;
                        hideSuggest();
                        state.startDayOffset = 1;
                        state.endDayOffset = 1;
                        syncDayGroups();
                        applyDefaultTimesIfEmpty();
                        updateSaveButtonState();
                    }
                    updateFormModeUi();
                }
                persistRisks();
                renderRisks();
                updateExportButtonState();
                if (global.Logger) global.Logger.info('新增风险已删除', { id: id, icao: r.icao });
                return;
            }

            // 既有风险：软删除，标记为「删除」，并保存原状快照供「还原」
            if (!r.backup) r.backup = snapshotRisk(r);
            r.modType = '删除';
            persistRisks();
            renderRisks();
            updateExportButtonState();
            if (global.Logger) global.Logger.info('风险标记为删除', { id: id, icao: r.icao });
            return;
        }

        // 正常删除逻辑（当日存档）
        var removed = state.risks.splice(idx, 1)[0];
        // 若删除的正是当前正在编辑的项，退出编辑态并清空表单
        if (state.editingId === id) {
            state.editingId = null;
            // 仅清空表单 UI，不影响已录入列表（列表自身已通过 renderRisks 重绘）
            if (elements.form) {
                if (elements.level) elements.level.value = '';
                if (elements.icao) elements.icao.value = '';
                if (elements.startTime) elements.startTime.value = '';
                if (elements.endTime) elements.endTime.value = '';
                if (elements.forecast) elements.forecast.value = '';
                var chips = document.querySelectorAll('.ndr-chip.active');
                Array.prototype.forEach.call(chips, function (c) { c.classList.remove('active'); });
                if (elements.icaoHint) elements.icaoHint.hidden = true;
                hideSuggest();
                state.startDayOffset = 1;
                state.endDayOffset = 1;
                syncDayGroups();
                applyDefaultTimesIfEmpty();
                updateSaveButtonState();
            }
            updateFormModeUi();
        }
        persistRisks();
        renderRisks();
        updateExportButtonState();
        if (global.Logger) global.Logger.info('次日风险已删除', { icao: removed.icao });
    }

    /**
     * 还原指定 id 的风险到操作前状态（删除/修订/升级/降级后使用）
     * @param {string} id
     */
    function restoreRisk(id) {
        var idx = -1;
        for (var i = 0; i < state.risks.length; i++) {
            if (state.risks[i].id === id) { idx = i; break; }
        }
        if (idx === -1) return;
        var r = state.risks[idx];
        // 无原状快照（如新增风险）不可还原
        if (!r.backup) return;

        // 还原为操作前原状，并清除标记与快照
        state.risks[idx] = r.backup;
        persistRisks();
        renderRisks();
        updateExportButtonState();
        if (global.Logger) {
            global.Logger.info('次日风险已还原', { id: id, icao: state.risks[idx].icao });
        }
    }

    /* ============================================================
     * 自定义确认弹窗
     * ------------------------------------------------------------
     * 替代浏览器原生 window.confirm，与整体 UI（毛玻璃、圆角、弹性缓动）统一
     * - 返回 Promise<boolean>：resolve(true) 表示用户确认，resolve(false) 表示取消/关闭
     * - 支持 Esc 键关闭、点击遮罩关闭、按钮事件统一通过 settle 闭包 resolve
     * ============================================================ */

    /**
     * 显示自定义确认弹窗，返回 Promise<boolean>
     * @param {Object} [opts]
     * @param {string} [opts.title]   弹窗标题，默认"确认操作"
     * @param {string} [opts.message] 弹窗正文（必填）
     * @param {string} [opts.confirmText] 确认按钮文字，默认"确认"
     * @param {string} [opts.cancelText]  取消按钮文字，默认"取消"
     * @param {boolean} [opts.danger]    是否显示为危险操作（确认按钮变红），默认 false
     * @returns {Promise<boolean>} true=用户确认；false=用户取消/关闭
     */
    function showConfirm(opts) {
        opts = opts || {};
        return new Promise(function (resolve) {
            var modal = elements.confirmModal;
            var titleEl = elements.confirmTitle;
            var msgEl = elements.confirmMessage;
            var okBtn = elements.confirmOk;
            var cancelBtn = elements.confirmCancel;
            if (!modal || !msgEl || !okBtn || !cancelBtn) {
                // 弹窗 DOM 不存在时回退到原生 confirm，保证功能不丢失
                if (typeof global.confirm === 'function') {
                    resolve(Boolean(global.confirm(opts.message || '确认操作？')));
                } else {
                    resolve(false);
                }
                return;
            }

            // 已 settled 标记：避免重复触发 resolve（防止 Esc/遮罩/按钮多次点击导致 Promise 状态错乱）
            var settled = false;
            function settle(result) {
                if (settled) return;
                settled = true;
                hide();
                resolve(result);
            }
            function hide() {
                modal.classList.remove('show');
                // 动画结束后彻底隐藏（与 CSS 过渡时长 220ms 保持一致）
                setTimeout(function () {
                    if (!settled) return;
                    modal.hidden = true;
                    // 清理事件监听器引用，避免内存泄漏
                    okBtn.onclick = null;
                    cancelBtn.onclick = null;
                    modal.onclick = null;
                    document.removeEventListener('keydown', onKeydown, true);
                }, 240);
            }
            function onKeydown(e) {
                if (e.key === 'Escape') {
                    e.preventDefault();
                    settle(false);
                } else if (e.key === 'Enter' && document.activeElement === okBtn) {
                    e.preventDefault();
                    settle(true);
                }
            }

            // 设置内容
            if (titleEl) titleEl.textContent = opts.title || '确认操作';
            msgEl.textContent = opts.message || '确认执行此操作？';
            okBtn.textContent = opts.confirmText || '确认';
            cancelBtn.textContent = opts.cancelText || '取消';
            // 危险模式：确认按钮红色样式
            okBtn.classList.toggle('danger', !!opts.danger);
            // 取消按钮始终是 ghost 样式，避免被 danger 污染
            cancelBtn.classList.remove('danger');

            // 绑定事件
            okBtn.onclick = function () { settle(true); };
            cancelBtn.onclick = function () { settle(false); };
            // 点击遮罩（卡片之外的区域）关闭 = 取消
            modal.onclick = function (e) {
                if (e.target === modal) settle(false);
            };
            document.addEventListener('keydown', onKeydown, true);

            // 显示：先 hidden=false，再下一帧加 show 触发动画
            modal.hidden = false;
            // 强制 reflow，确保 transition 生效
            void modal.offsetWidth;
            modal.classList.add('show');
            // 自动聚焦取消按钮，防止回车误触发确认
            setTimeout(function () {
                try { cancelBtn.focus(); } catch (e) {}
            }, 60);
        });
    }

    /**
     * 全部清空已录入风险（带自定义确认弹窗，与整体 UI 风格统一）
     */
    function clearAllRisks() {
        if (!state.risks || state.risks.length === 0) return;
        var count = state.risks.length;
        var archiveLabel = state.isModArchive ? '前一日' : '当日';
        var message = '确认要清空【' + archiveLabel + '】全部 ' + count + ' 条已录入风险吗？此操作不可撤销。';
        showConfirm({
            title: '全部清空',
            message: message,
            confirmText: '清空',
            danger: true
        }).then(function (ok) {
            if (!ok) return;
            state.risks = [];
            persistRisks();
            renderRisks();
            updateExportButtonState();
            if (global.Logger) global.Logger.info('次日风险全部清空', { count: count, archive: archiveLabel });
        });
    }

    /**
     * 重置表单（不影响已录入列表）
     * 同时重置 +1 按钮激活态、清除编辑态
     */
    function resetForm() {
        var form = elements.form;
        if (!form) return;
        // 退出编辑态
        state.editingId = null;
        updateFormModeUi();
        // 通过 elements.* 安全写入空值，避免对 form.name 旧行为的依赖
        if (elements.level) elements.level.value = '';
        if (elements.icao) elements.icao.value = '';
        if (elements.startTime) elements.startTime.value = '';
        if (elements.endTime) elements.endTime.value = '';
        if (elements.forecast) elements.forecast.value = '';
        // 清除已选 chip
        var chips = document.querySelectorAll('.ndr-chip.active');
        Array.prototype.forEach.call(chips, function (c) { c.classList.remove('active'); });
        // 隐藏机场提示与联想
        if (elements.icaoHint) elements.icaoHint.hidden = true;
        hideSuggest();
        // 重置日期偏移（默认次日）与按钮视觉
        state.startDayOffset = 1;
        state.endDayOffset = 1;
        syncDayGroups();
        // 重置后立即填入"次日"默认时间
        applyDefaultTimesIfEmpty();
        updateSaveButtonState();
    }

    /**
     * 取消编辑：清空 editingId 并重置表单（不影响已录入列表）
     */
    function cancelEdit() {
        if (!state.editingId) return;
        if (global.Logger) global.Logger.info('次日风险：取消编辑', { id: state.editingId });
        resetForm();
    }

    /**
     * 把已录入风险的内容回填到表单，供用户再次修改
     * 同时切换到编辑模式（更新保存按钮、显示"取消编辑"按钮、修改标题）
     * @param {object} risk
     */
    function fillFormFromRisk(risk) {
        if (!risk) return;
        // 1) 关注等级：还原为完整 label
        if (elements.level) {
            var labelMap = { '黄': LEVEL_OPTIONS[0].label, '橙': LEVEL_OPTIONS[1].label, '红': LEVEL_OPTIONS[2].label };
            elements.level.value = labelMap[risk.level] || '';
        }
        // 2) 机场 ICAO：直接写值 + 显示已识别 hint
        if (elements.icao) {
            elements.icao.value = risk.icao || '';
            var name = (global.AirportTemplate && global.AirportTemplate.getNameByIcao)
                ? global.AirportTemplate.getNameByIcao(risk.icao) : '';
            if (elements.icaoHint) {
                if (name) {
                    elements.icaoHint.textContent = '✓ 已识别：' + name;
                    elements.icaoHint.className = 'ndr-hint ok';
                    elements.icaoHint.hidden = false;
                } else {
                    elements.icaoHint.hidden = true;
                }
            }
            hideSuggest();
        }
        // 3) 天气类型：按 risk.weatherTypes 勾选 chip
        var allChips = document.querySelectorAll('.ndr-chip');
        var selected = {};
        (risk.weatherTypes || []).forEach(function (t) { selected[t] = true; });
        Array.prototype.forEach.call(allChips, function (c) {
            if (selected[c.getAttribute('data-value')]) c.classList.add('active');
            else c.classList.remove('active');
        });
        // 4) 影响开始/结束时间：直接回填 + 同步日期偏移
        var startVal = (risk.startTime && risk.startTime.value) || '';
        var endVal = (risk.endTime && risk.endTime.value) || '';
        if (elements.startTime) elements.startTime.value = startVal;
        if (elements.endTime) elements.endTime.value = endVal;
        // 同步日期偏移：根据风险日期属于"次日"还是"后日"决定
        state.startDayOffset = getDayOffsetFromDateStr(startVal);
        state.endDayOffset = getDayOffsetFromDateStr(endVal);
        syncDayGroups();
        // 5) 气象预报
        if (elements.forecast) elements.forecast.value = risk.forecast || '';
        // 6) 切换到编辑模式（仅在当前区域内更新视觉，不滚动页面或转移焦点）
        state.editingId = risk.id;
        updateFormModeUi();
        updateSaveButtonState();
        if (global.Logger) global.Logger.info('次日风险已回填到表单', { id: risk.id, icao: risk.icao });
    }

    /**
     * 判断日期字符串 yyyy/m/d 属于「次日」还是「后日」，返回对应日期偏移
     * 用于回填时同步日期偏移按钮状态
     * @param {string} value
     * @returns {number} 0=当日，1=次日，2=后日；无法识别时默认次日
     */
    function getDayOffsetFromDateStr(value) {
        if (!value) return 1;
        var m = String(value).match(/^(\d{4})[\-\/](\d{1,2})[\-\/](\d{1,2})/);
        if (!m) return 1;
        var today = getBeijingParts();
        var y = parseInt(m[1], 10), mo = parseInt(m[2], 10), d = parseInt(m[3], 10);
        var tomorrow = addOneDay(today);
        var dayAfter = addDays(today, 2);
        if (y === today.y && mo === today.m && d === today.d) return 0;
        if (y === tomorrow.y && mo === tomorrow.m && d === tomorrow.d) return 1;
        if (y === dayAfter.y && mo === dayAfter.m && d === dayAfter.d) return 2;
        return 1;
    }

    /**
     * 根据 state.editingId 切换 UI（标题、保存按钮文字、取消编辑按钮可见性、卡片高亮）
     */
    function updateFormModeUi() {
        // 标题
        var titleEl = document.getElementById('ndr-form-title');
        if (titleEl) {
            titleEl.textContent = state.editingId ? '编辑风险' : '新增风险';
            titleEl.classList.toggle('editing', !!state.editingId);
        }
        // 保存按钮
        if (elements.save) {
            elements.save.textContent = state.editingId ? '更新' : '保存';
        }
        // 取消编辑按钮
        var cancelBtn = document.getElementById('ndr-cancel-edit');
        if (cancelBtn) {
            cancelBtn.hidden = !state.editingId;
        }
        // 卡片高亮：仅当前正在编辑的卡片加 .is-editing
        var cards = document.querySelectorAll('.ndr-card');
        Array.prototype.forEach.call(cards, function (c) {
            if (c.getAttribute('data-id') === state.editingId) c.classList.add('is-editing');
            else c.classList.remove('is-editing');
        });
    }

    /**
     * 持久化当前 risks 列表到 Storage
     */
    function persistRisks() {
        try {
            var archiveKey = state.currentArchiveKey || getArchiveKey(0, 'PM');
            ArchiveManager.save(archiveKey, state.risks);
            // 同时更新内存缓存
            state.archiveStore[archiveKey] = state.risks.slice();
        } catch (e) {
            if (global.Logger) global.Logger.error('次日风险持久化失败', e && e.message);
        }
    }

    /**
     * 从 Storage 恢复 risks 列表
     */
    function loadRisks() {
        try {
            var archiveKey = state.currentArchiveKey || getArchiveKey(0, 'PM');
            // 是否 0730 修改档：仅修改档保留 modType/isNew/backup 标记；
            // 1530/1930 为普通录入档，加载时剥离一切修改标记，确保不显示标签（兼容历史残留数据）
            var isMod = isModificationArchiveKey(archiveKey);
            var arr = ArchiveManager.load(archiveKey);
            if (Array.isArray(arr)) {
                state.risks = arr.map(function (r) {
                    return {
                        id: r.id || ('r_' + (r.ts || Date.now()) + '_' + Math.random().toString(36).slice(2, 8)),
                        level: r.level,
                        icao: r.icao,
                        weatherTypes: Array.isArray(r.weatherTypes) ? r.weatherTypes : [],
                        startTime: typeof r.startTime === 'string'
                            ? { ok: true, value: r.startTime }
                            : (r.startTime || { ok: false, value: '' }),
                        endTime: typeof r.endTime === 'string'
                            ? { ok: true, value: r.endTime }
                            : (r.endTime || { ok: false, value: '' }),
                        forecast: r.forecast || '',
                        ts: r.ts || Date.now(),
                        modType: isMod ? (r.modType || null) : null,
                        // 新增标识：仅 0730 修改档记录"由用户新增到当前存档"的风险，删除时直接移除卡片
                        isNew: isMod ? !!r.isNew : undefined,
                        // 操作前快照：仅 0730 修改档用于「还原」恢复到操作前状态（既有风险修改时生成）
                        backup: isMod ? (r.backup || null) : null
                    };
                });
            }
            // 更新内存缓存
            state.archiveStore[archiveKey] = state.risks.slice();
        } catch (e) {
            if (global.Logger) global.Logger.error('次日风险加载失败', e && e.message);
            state.risks = [];
        }
    }

    /**
     * 确保「今日 0730 修改档」已继承前一日 1530 的预警机场内容
     *  - 语义：每日 0730 气象预报 = 对前一日 1530 气象预报的修改
     *  - 触发时机：工具每次打开初始化时自动调用（必须在过期存档清理之前执行，否则昨日数据会被清掉）
     *  - 仅当今日 0730 为空、且前一日 1530 有数据时才复制（幂等，不覆盖已有内容）
     *  - 若昨日 1530 为空/不存在，今日 0730 保持为空
     *  - 复制时清空修改标记（modType/isNew/backup）并生成新 id，作为全新修改基底
     */
    function ensureModArchiveCopy() {
        try {
            var todayKey = getArchiveKey(0, MODIFICATION_PERIOD);   // 今日 0730
            var existing = ArchiveManager.load(todayKey);
            if (existing.length > 0) return;                        // 已有内容，不覆盖

            var prevKey = getArchiveKey(-1, '1530');                 // 前一日 1530
            var source = ArchiveManager.load(prevKey);
            if (source.length === 0) return;                        // 昨日 1530 为空，今日 0730 保持为空

            // 深拷贝并清空修改标记，作为修改基底
            var copied = source.map(function (r) {
                return {
                    id: 'r_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
                    level: r.level,
                    icao: r.icao,
                    weatherTypes: Array.isArray(r.weatherTypes) ? r.weatherTypes.slice() : [],
                    startTime: typeof r.startTime === 'string'
                        ? { ok: true, value: r.startTime }
                        : (r.startTime || { ok: false, value: '' }),
                    endTime: typeof r.endTime === 'string'
                        ? { ok: true, value: r.endTime }
                        : (r.endTime || { ok: false, value: '' }),
                    forecast: r.forecast || '',
                    ts: Date.now(),
                    modType: null,
                    isNew: undefined,
                    backup: null
                };
            });

            ArchiveManager.save(todayKey, copied);
            state.archiveStore[todayKey] = copied.slice();
            if (global.Logger) {
                global.Logger.info('前一日1530已复制到今日0730', { source: prevKey, count: copied.length });
            }
        } catch (e) {
            if (global.Logger) global.Logger.error('今日0730复制失败', e && e.message);
        }
    }

    /**
     * 切换到指定存档
     * @param {string} archiveKey 格式：YYYYMMDD_0730/1530/1930
     */
    function switchArchive(archiveKey) {
        if (!archiveKey) return;

        // 先保存当前存档的数据，避免切换时丢失
        if (state.currentArchiveKey && state.currentArchiveKey !== archiveKey) {
            ArchiveManager.save(state.currentArchiveKey, state.risks);
        }

        state.currentArchiveKey = archiveKey;

        // 判断是否为修改档（0730 时段，继承前一日 1530 并对既有风险做修改）
        state.isModArchive = isModificationArchiveKey(archiveKey);

        // 切到今日 0730 时，确保已继承前一日 1530（幂等：已有内容则跳过）
        ensureModArchiveCopy();

        // 加载该存档的风险数据
        loadRisks();

        // 记录当前存档选择
        ArchiveManager.setCurrent(archiveKey);

        // 统一刷新 UI
        renderAll();

        if (global.Logger) {
            global.Logger.info('存档已切换', { archiveKey: archiveKey, isHistory: state.isModArchive, count: state.risks.length });
        }
    }

    /**
     * 应用存档视图限制（历史存档只读模式）
     * 当 isHistoryArchive 为 true 时：
     *   - 禁用导出、截图、航班上传、保存等按钮
     *   - 日期按钮强制选中"当日"并禁用
     *   - 左右栏添加 .is-archive-history 类
     * 当切换回当日存档时，移除上述限制
     */
    function applyArchiveViewRestrictions() {
        var isHistory = state.isModArchive;

        // 导出按钮禁用（仅列表为空时禁用）
        var exportDisabled = state.risks.length === 0;
        if (elements.exportExcel) {
            elements.exportExcel.disabled = exportDisabled;
            if (!exportDisabled) elements.exportExcel.removeAttribute('disabled');
        }
        if (elements.exportAoc) {
            elements.exportAoc.disabled = exportDisabled;
            if (!exportDisabled) elements.exportAoc.removeAttribute('disabled');
        }
        if (elements.screenshot) {
            elements.screenshot.disabled = exportDisabled;
            if (!exportDisabled) elements.screenshot.removeAttribute('disabled');
        }

        // 航班上传按钮 + 文件输入禁用
        var uploadBtn = document.querySelector('.ndr-upload-btn');
        var flightsFile = document.getElementById('ndr-flights-file');
        if (uploadBtn) {
            uploadBtn.style.pointerEvents = isHistory ? 'none' : '';
            uploadBtn.style.opacity = isHistory ? '0.5' : '';
        }
        if (flightsFile) {
            flightsFile.disabled = isHistory;
        }

        // 日期按钮禁用 + 直接设置内联样式确保视觉清晰
        var dayBtns = document.querySelectorAll('.ndr-day-btn');
        dayBtns.forEach(function (btn) {
            btn.disabled = isHistory;
        });
        // 重新同步按钮视觉样式（会根据 disabled 状态应用正确的内联样式）
        syncDayGroups();

        // 录入区与预览区底色切换
        var leftCol = document.querySelector('.ndr-col-left');
        var rightCol = document.querySelector('.ndr-col-right');
        if (isHistory) {
            if (leftCol) leftCol.classList.add('is-archive-history');
            if (rightCol) rightCol.classList.add('is-archive-history');
        } else {
            if (leftCol) leftCol.classList.remove('is-archive-history');
            if (rightCol) rightCol.classList.remove('is-archive-history');
        }
    }

    /**
     * 切换存档后的统一刷新入口
     * 刷新：存档 Tab、风险列表、按钮状态、日期按钮、区域底色
     */
    function renderAll() {
        updateArchiveTabsActive();
        renderRisks();

        // 历史存档：日期按钮强制"当日"并禁用；当日存档：恢复默认"次日"
        if (state.isModArchive) {
            state.startDayOffset = 0;
            state.endDayOffset = 0;
            syncDayGroup(elements.startDayGroup, 0);
            syncDayGroup(elements.endDayGroup, 0);
            if (elements.startTime) elements.startTime.value = '';
            if (elements.endTime) elements.endTime.value = '';
            applyDefaultTimesIfEmpty();
        } else {
            state.startDayOffset = 1;
            state.endDayOffset = 1;
            syncDayGroup(elements.startDayGroup, 1);
            syncDayGroup(elements.endDayGroup, 1);
            if (elements.startTime) elements.startTime.value = '';
            if (elements.endTime) elements.endTime.value = '';
            applyDefaultTimesIfEmpty();
        }

        applyArchiveViewRestrictions();
        updateExportButtonState();
        updateSaveButtonState();
        updateFormModeUi();
        state.editingId = null;
    }

    /* ============================================================
     * 事件绑定
     * ============================================================ */

    /**
     * 绑定表单事件
     * 使用 elements.* 而非 form.* 访问输入框，避免对 form.name 旧行为的依赖
     * elements 中的引用由 collectElements() 通过 form.elements['name'] 设置
     */
    function bindFormEvents() {
        var form = elements.form;
        if (!form) return;

        // 机场输入：实时过滤 + 大写 + 提示 + 联想
        if (elements.icao) {
            elements.icao.addEventListener('input', function () {
                var sanitized = sanitizeIcaoInput(elements.icao.value);
                if (elements.icao.value !== sanitized) elements.icao.value = sanitized;
                var hint = elements.icaoHint;
                // 4 位且合法 → 隐藏 hint 与联想
                if (sanitized.length === 4) {
                    if (C0039_ICAOS[sanitized]) {
                        var nm = (global.AirportTemplate && global.AirportTemplate.getNameByIcao)
                            ? global.AirportTemplate.getNameByIcao(sanitized) : '';
                        hint.textContent = '✓ ' + (nm || '已识别');
                        hint.className = 'ndr-hint ok';
                        hint.hidden = false;
                    } else {
                        hint.textContent = '✗ 该机场不在 C0039 列表中';
                        hint.className = 'ndr-hint err';
                        hint.hidden = false;
                    }
                    hideSuggest();
                } else if (sanitized.length > 0) {
                    // 1-3 位：显示联想
                    hint.hidden = true;
                    var items = buildSuggestList(sanitized);
                    renderSuggest(items);
                } else {
                    // 0 位：清空 hint 与联想
                    hint.hidden = true;
                    hideSuggest();
                }
                updateSaveButtonState();
            });
        }

        // 联想浮层：键盘 ↓/↑/Enter/Esc
        if (elements.suggest) {
            elements.suggest.addEventListener('mousedown', function (e) {
                // 阻止默认，避免 input 失焦触发 blur
                e.preventDefault();
            });
        }

        if (elements.icao) {
            elements.icao.addEventListener('keydown', function (e) {
                if (!elements.suggest || elements.suggest.hidden) return;
                var max = suggestState.items.length;
                if (max === 0) return;
                if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    var next = (suggestState.activeIdx + 1) % max;
                    setSuggestActive(next);
                } else if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    var prev = (suggestState.activeIdx - 1 + max) % max;
                    setSuggestActive(prev);
                } else if (e.key === 'Enter') {
                    if (suggestState.activeIdx >= 0) {
                        e.preventDefault();
                        selectSuggestByIndex(suggestState.activeIdx);
                    } else if (max > 0) {
                        // 没有高亮但有候选 → 选中第一个
                        e.preventDefault();
                        selectSuggestByIndex(0);
                    }
                } else if (e.key === 'Escape') {
                    e.preventDefault();
                    hideSuggest();
                }
            });

            elements.icao.addEventListener('blur', function () {
                // 延迟关闭，让 mousedown 能正常触发
                setTimeout(hideSuggest, 120);
            });
        }

        // 关注等级：input 事件做快捷键展开
        if (elements.level) {
            elements.level.addEventListener('input', function () {
                var lv = applyLevelShortcut(elements.level.value);
                if (lv.changed && elements.level.value !== lv.value) {
                    elements.level.value = lv.value;
                    // 选中末尾便于用户继续编辑
                    try { elements.level.setSelectionRange(lv.value.length, lv.value.length); } catch (e) {}
                }
                updateSaveButtonState();
            });
        }

        // 时间输入：input/blur 自动展开 + 更新按钮状态
        function handleTimeInput(input) {
            if (!input) return;
            tryAutoExpandTime(input);
            updateSaveButtonState();
        }
        if (elements.startTime) {
            elements.startTime.addEventListener('input', function () { handleTimeInput(elements.startTime); });
            elements.startTime.addEventListener('blur', function () { tryAutoExpandTime(elements.startTime); });
        }
        if (elements.endTime) {
            elements.endTime.addEventListener('input', function () { handleTimeInput(elements.endTime); });
            elements.endTime.addEventListener('blur', function () { tryAutoExpandTime(elements.endTime); });
        }
        // 日期按钮组点击已由 SegmentedControl 组件接管（见 bindDayGroupControls 的 onChange）
        // 开始/结束时间共用组件回调，无需在此重复绑定

        // 气象预报
        if (elements.forecast) {
            elements.forecast.addEventListener('input', updateSaveButtonState);
        }

        // 保存
        if (elements.save) {
            elements.save.addEventListener('click', function () { addRisk(); });
        }
        // 重置
        if (elements.reset) {
            elements.reset.addEventListener('click', function () { resetForm(); });
        }
        // 取消编辑（仅在编辑模式下可见）
        var cancelEditBtn = document.getElementById('ndr-cancel-edit');
        if (cancelEditBtn) {
            cancelEditBtn.addEventListener('click', function () { cancelEdit(); });
        }
        // 全部清空
        if (elements.clearAll) {
            elements.clearAll.addEventListener('click', function () { clearAllRisks(); });
        }
    }

    /**
     * 绑定导出按钮事件
     */
    function bindExportEvents() {
        if (elements.exportExcel) {
            elements.exportExcel.addEventListener('click', function () {
                if (global.NextDayRiskExcel && typeof global.NextDayRiskExcel.exportRisks === 'function') {
                    global.NextDayRiskExcel.exportRisks();
                } else {
                    if (global.Logger) global.Logger.error('Excel 导出器未加载');
                }
            });
        }
        if (elements.screenshot) {
            elements.screenshot.addEventListener('click', function () {
                // 委托给 AirportWarningScreenshot 模块：弹窗预览 + 自动复制剪贴板
                if (global.AirportWarningScreenshot && typeof global.AirportWarningScreenshot.handleButtonClick === 'function') {
                    global.AirportWarningScreenshot.handleButtonClick();
                } else {
                    if (global.Logger) global.Logger.error('截图模块未加载');
                }
            });
        }
        if (elements.exportAoc) {
            elements.exportAoc.addEventListener('click', function () {
                if (global.AocRiskShareExport && typeof global.AocRiskShareExport.exportRisks === 'function') {
                    global.AocRiskShareExport.exportRisks();
                } else {
                    if (global.Logger) global.Logger.error('AOC 共享表格导出模块未加载');
                }
            });
        }
    }

    /**
     * 收集 DOM 元素引用
     * 使用 form.elements['name'] 而非 form.name
     * - form.name 依赖 HTMLFormElement 的 namedItem 旧行为（HTML4），
     *   部分浏览器/环境可能不支持，会导致快捷功能初始化失败
     * - form.elements['name'] 是 HTMLFormControlsCollection 的标准接口，所有环境均可用
     */
    function collectElements() {
        elements.form = document.getElementById('ndr-form');
        if (!elements.form) return false;
        // 通过 form.elements['name'] 安全获取，避免对 form.name 的旧行为依赖
        elements.level = elements.form.elements['level'] || null;
        elements.icao = elements.form.elements['icao'] || null;
        elements.startTime = elements.form.elements['startTime'] || null;
        elements.endTime = elements.form.elements['endTime'] || null;
        elements.startDayGroup = document.getElementById('ndr-start-day-group');
        elements.endDayGroup = document.getElementById('ndr-end-day-group');
        elements.forecast = elements.form.elements['forecast'] || null;
        elements.weatherChips = document.getElementById('ndr-weather-chips');
        elements.error = document.getElementById('ndr-error');
        elements.save = document.getElementById('ndr-save');
        elements.reset = document.getElementById('ndr-reset');
        elements.icaoHint = document.getElementById('ndr-icao-hint');
        elements.suggest = document.getElementById('ndr-suggest');
        elements.list = document.getElementById('ndr-list');
        elements.empty = document.getElementById('ndr-empty');
        elements.count = document.getElementById('ndr-count');
        elements.clearAll = document.getElementById('ndr-clear-all');
        elements.exportExcel = document.getElementById('ndr-export-excel');
        elements.screenshot = document.getElementById('ndr-screenshot');
        elements.exportAoc = document.getElementById('ndr-export-aoc');
        // 自定义确认弹窗
        elements.confirmModal = document.getElementById('confirm-modal');
        elements.confirmTitle = document.getElementById('confirm-modal-title');
        elements.confirmMessage = document.getElementById('confirm-modal-message');
        elements.confirmOk = document.getElementById('confirm-modal-ok');
        elements.confirmCancel = document.getElementById('confirm-modal-cancel');
        elements.archiveTabs = document.getElementById('ndr-archive-tabs');
        return true;
    }

    /**
     * 初始化入口
     */
    function init() {
        if (!collectElements()) {
            if (global.Logger) global.Logger.warn('次日风险模块：未找到表单 DOM，跳过初始化');
            return;
        }
        // 存档初始化流程（顺序关键）：
        //   1) 先迁移旧数据（旧 AM/PM → 新时段，含昨日 PM→1530）
        //   2) 再复制昨日 1530 → 今日 0730（作为修改基底）
        //   3) 最后清理过期存档（含前一日，复制完成后不再展示/保存）
        ArchiveManager.migrateLegacy();
        ensureModArchiveCopy();
        ArchiveManager.pruneExpired();
        state.currentArchiveKey = ArchiveManager.getCurrent();
        state.isModArchive = isModificationArchiveKey(state.currentArchiveKey);

        renderWeatherChips();
        // 初始化日期选择分段控件（为 syncDayGroup/点击 提供实例）
        bindDayGroupControls();
        bindFormEvents();
        bindExportEvents();
        loadRisks();
        // 渲染存档 Tab（内部已接入 SegmentedControl 处理切换）
        renderArchiveTabs(state.currentArchiveKey);
        // 如果是历史存档，应用限制
        applyArchiveViewRestrictions();
        // 渲染风险列表和按钮状态
        renderRisks();
        updateExportButtonState();
        updateSaveButtonState();
        syncDayGroups();
        // 如果是历史存档，日期按钮默认选中"当日"
        if (state.isModArchive) {
            selectDayOffset('start', '0');
            selectDayOffset('end', '0');
        } else {
            applyDefaultTimesIfEmpty();
        }
        updateFormModeUi();
        // 初始化 AOC 航班上传 UI（恢复本地缓存状态、绑定文件选择/清除）
        if (global.AocRiskShareExport && typeof global.AocRiskShareExport.initUploadUi === 'function') {
            global.AocRiskShareExport.initUploadUi();
        }
        if (global.Logger) global.Logger.info('次日风险模块已初始化（已录入 ' + state.risks.length + ' 条）');
    }

    /* ============================================================
     * 暴露 API
     * ============================================================ */
    global.NextDayRiskModule = {
        init: init,
        /** 返回当前已录入风险数组的副本（避免外部修改内部状态） */
        getRisks: function () { return state.risks.slice(); },
        /** 清空全部已录入风险（调试 / 演示用） */
        clearAll: function () {
            state.risks = [];
            persistRisks();
            renderRisks();
            updateExportButtonState();
            if (global.Logger) global.Logger.info('次日风险列表已清空');
        },
        // 暴露内部纯函数，便于单元测试
        _sanitizeIcaoInput: sanitizeIcaoInput,
        _parseTimeInput: parseTimeInput,
        _formatTimeForInput: formatTimeForInput,
        _applyLevelShortcut: applyLevelShortcut,
        _buildSuggestList: buildSuggestList,
        _showConfirm: showConfirm,
        _selectDayOffset: selectDayOffset,
        _addOneDay: addOneDay,
        _addDays: addDays,
        _getBeijingParts: getBeijingParts,
        _formatDateTimeParts: formatDateTimeParts,
        _applyDefaultTimesIfEmpty: applyDefaultTimesIfEmpty,
        _fillFormFromRisk: fillFormFromRisk,
        _cancelEdit: cancelEdit,
        _getDayOffsetFromDateStr: getDayOffsetFromDateStr,
        _getEditingId: function () { return state.editingId; },
        /** 返回 state 快照（仅用于测试），外部不要修改 */
        _getState: function () { return { startDayOffset: state.startDayOffset, endDayOffset: state.endDayOffset, editingId: state.editingId }; },
        _ArchiveManager: ArchiveManager,
        _switchArchive: switchArchive,
        _getBeijingDateKey: getBeijingDateKey,
        _getArchiveKey: getArchiveKey,
        _getPeriodByDateTime: getPeriodByDateTime,
        _parseArchiveKey: parseArchiveKey,
        _formatDateKeyLabel: formatDateKeyLabel
    };
})(typeof window !== 'undefined' ? window : this);
