/**
 * 「机场预警模板发布」模块
 * --------------------------------------------------------------------
 * 设计目标：
 *   1. 严格对齐气象台《橙色预警（低云低能见度）》模板的视觉风格
 *      - 标题行：橙底 / 等级色文字 / 宋体 26pt（仅用于实时预览的视觉规范）
 *      - 表格边框：F89F48 / size 12（仅用于实时预览的视觉规范）
 *      - 页边距：1440 / 1800 / 1440 / 1800（仅用于实时预览的视觉规范）
 *   2. 表单 → 实时预览 → 确认发布序号（上报自建服务器）→ 一键截图（剪贴板 PNG）→ 导出历史预警记录（Excel）
 *   3. 草稿持久化到 Storage（chrome.storage.local 代理），键名
 *      met_tool_warning_template_draft
 *   4. 旧键 met_tool_warning_draft 仅在首次加载时记录一次 warn 日志，不再读取
 *
 * 颜色变量与等级文案集中在 LEVEL_COLORS / LEVEL_TEXT 常量
 * 拒绝硬编码，便于后续扩展第 5 级预警或修改样式
 */
(function (global) {
    'use strict';

    /* ============================================================
     * 常量
     * ============================================================ */

    /** 当前模板草稿存储键 */
    var STORAGE_KEY = 'met_tool_warning_template_draft';

    /** 旧版本存储键（仅用于一次性 warn 日志，不再读取） */
    var OLD_STORAGE_KEY = 'met_tool_warning_draft';

    /** 发布序号计数器：{ date: '20260718', count: 5 } 跨日自动重置 */
    var SERIAL_COUNTER_KEY = 'met_tool_warning_serial_counter';

    /** 固定气象席电话（用户需求 v2：写死 0871-67087127） */
    var FIXED_PHONE = '0871-67087127';

    /** 表单字段顺序（用于 readForm / fillForm） */
    var FIELDS = [
        'airport', 'level', 'phenomenon', 'serialNo',
        'publishTime', 'phone', 'current', 'forecast', 'producer'
    ];

    /** 必填字段（缺失时阻断截图/导出；隐藏的 phone/producer/publishTime/serialNo 不在此列） */
    var REQUIRED = ['airport', 'level', 'phenomenon', 'current', 'forecast'];

    /**
     * 4 级预警颜色（沿用气象台模板视觉规范）
     * - bg        标题行背景色
     * - text      标题行文字色（机场名沿用黑色 #000000，不参与级别切换）
     * - phenomenon 左侧天气现象列文字色
     */
    var LEVEL_COLORS = {
        '红': { bg: '#E74C3C', text: '#FFFFFF', phenomenon: '#C0392B' },
        '橙': { bg: '#F89F48', text: '#404040', phenomenon: '#F78D1E' },
        '黄': { bg: '#FFEE00', text: '#7E5109', phenomenon: '#7E5109' }
    };

    /** 等级中文名映射 */
    var LEVEL_TEXT = { '红': '红色', '橙': '橙色', '黄': '黄色' };

    /** 防抖延迟 */
    var DEBOUNCE_MS = 300;

    /** 按钮反馈持续时间 */
    var FLASH_MS = 1500;

    /** 剪贴板写入最大尝试次数（Windows 下失败多为瞬时故障，重试可显著提升成功率） */
    var CLIPBOARD_MAX_ATTEMPTS = 3;
    /** 各次重试前的等待时长（毫秒，下标 = 已失败次数；第 1 次不等待） */
    var CLIPBOARD_RETRY_DELAYS = [0, 200, 500];

    /** 标记：是否已记录旧草稿的 warn */
    var oldDraftLogged = false;

    /* ============================================================
     * 内部状态
     * ============================================================ */

    var elements = {};
    var lastRenderData = null;  // 最近一次 render 的数据（用于截图前对照）

    /* ============================================================
     * 工具函数
     * ============================================================ */

    /** 两位数字补零 */
    function pad2(n) { return n < 10 ? '0' + n : '' + n; }

    /**
     * 格式化为 `yyyy年M月d日HH:mm`（用于发布时间显示）
     * @param {Date} d
     * @returns {string}
     */
    function formatBeijingTime(d) {
        if (!d || isNaN(d.getTime())) return '';
        return d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日' +
            pad2(d.getHours()) + ':' + pad2(d.getMinutes());
    }

    /**
     * 格式化为 `yyyyMMdd_HHmmss`（用于文件名时间戳）
     * @param {Date} d
     * @returns {string}
     */
    function formatStamp(d) {
        if (!d) d = new Date();
        return d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) + '_' +
            pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds());
    }

    /**
     * 获取北京时（UTC+8）的格式化字符串 `yyyy年M月d日HH:mm`
     * @param {Date} [d] 不传则取当前
     * @returns {string}
     */
    function getCurrentBeijingTime(d) {
        if (!d) d = new Date();
        // UTC 毫秒 + 8h offset
        var utc = d.getTime() + d.getTimezoneOffset() * 60 * 1000;
        var beijing = new Date(utc + 8 * 60 * 60 * 1000);
        return beijing.getFullYear() + '年' + (beijing.getMonth() + 1) + '月' + beijing.getDate() + '日' +
            pad2(beijing.getHours()) + ':' + pad2(beijing.getMinutes());
    }

    /**
     * 获取北京时的 `yyyyMMdd` 日期戳（用于序号计数器跨日重置）
     * @param {Date} [d]
     * @returns {string} 8 位数字
     */
    function getBeijingDateStamp(d) {
        if (!d) d = new Date();
        var utc = d.getTime() + d.getTimezoneOffset() * 60 * 1000;
        var beijing = new Date(utc + 8 * 60 * 60 * 1000);
        return beijing.getFullYear() + pad2(beijing.getMonth() + 1) + pad2(beijing.getDate());
    }

    /**
     * 消费一个发布序号：自增当日计数器，返回 `yyyyMMddNNN` 格式字符串
     * 跨日自动重置到 001
     * - 存储位置: chrome.storage.local 键 SERIAL_COUNTER_KEY
     * - 并发安全: Storage.get / Storage.set 自带序列化
     * @returns {Promise<string>} 12 位字符串
     */
    function consumeSerialNumber() {
        return Promise.resolve(Storage.get(SERIAL_COUNTER_KEY)).then(function (rec) {
            var today = getBeijingDateStamp(new Date());
            var count = 0;
            if (rec && rec.date === today && typeof rec.count === 'number') {
                count = rec.count;
            }
            count += 1;
            return Promise.resolve(Storage.set(SERIAL_COUNTER_KEY, { date: today, count: count })).then(function () {
                return today + String(count).padStart(3, '0');
            });
        }).catch(function (e) {
            logWarn('warning serial consume failed, use timestamp fallback', e && e.message);
            // 失败回退：用当前时间戳后 3 位
            return getBeijingDateStamp(new Date()) + String(Date.now() % 1000).padStart(3, '0');
        });
    }

    /**
     * 读取当日序号计数器记录
     * @returns {{date:string, count:number}|null}
     */
    function readSerialCounter() {
        try {
            var rec = Storage.get(SERIAL_COUNTER_KEY);
            if (rec && rec.date && typeof rec.count === 'number') return rec;
        } catch (e) { /* ignore */ }
        return null;
    }

    /**
     * 写入当日序号计数器记录
     * @param {{date:string, count:number}} rec
     */
    function writeSerialCounter(rec) {
        try { Storage.set(SERIAL_COUNTER_KEY, rec); } catch (e) {
            logWarn('warning serial counter write failed', e && e.message);
        }
    }

    /**
     * 获取「下一份预警」的默认序号：基于上次确认值 + 1
     * 跨日自动重置到 001
     * - 若当日有确认记录（date 匹配 today 且 count > 0）→ 返回 today + String(count + 1).padStart(3, '0')
     * - 否则 → 返回 today + '001'
     * @returns {string} 12 位字符串（如 `20260718001`）
     */
    function getNextSerial() {
        var rec = readSerialCounter();
        var today = getBeijingDateStamp(new Date());
        var count = (rec && rec.date === today && typeof rec.count === 'number' && rec.count > 0)
            ? rec.count + 1
            : 1;
        return today + String(count).padStart(3, '0');
    }

    /**
     * 显式确认一个发布序号并持久化
     * 解析 `serialValue`（形如 `20260718005`），提取 NNN 部分，更新计数器
     * - 若解析失败或越界（< 1 或 > 999）→ 静默忽略
     * - 序号所属日期若与今日不同 → 仍按 NNN 写入（应对跨日手动调整）
     * @param {string} serialValue
     */
    function confirmSerial(serialValue) {
        if (!serialValue || typeof serialValue !== 'string') return;
        var match = String(serialValue).match(/^(\d{8})(\d{3})$/);
        if (!match) return;
        var date = match[1];
        var nnn = parseInt(match[2], 10);
        if (isNaN(nnn) || nnn < 1 || nnn > 999) return;
        writeSerialCounter({ date: date, count: nnn });
    }

    /** HTML 转义（防 XSS / 防截断） */
    function escapeHtml(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    /**
     * 数字 → 完整等级名映射（用于输入框展示）
     * 1 → '黄色'  2 → '橙色'  3 → '红色'
     * @param {string} chLevel 黄/橙/红 单字
     * @returns {string} 黄色/橙色/红色
     */
    function levelToDisplay(chLevel) {
        return LEVEL_TEXT[chLevel] || '';
    }

    /**
     * 数字 → 等级字符映射（兼容读取）
     * 1 → '黄'  2 → '橙'  3 → '红'
     * @param {string} raw
     * @returns {string} 黄/橙/红 或原值
     */
    function normalizeLevel(raw) {
        if (raw == null) return '';
        var s = String(raw).trim();
        if (!s) return '';
        if (s === '1' || s === '黄色' || s === '黄') return '黄';
        if (s === '2' || s === '橙色' || s === '橙') return '橙';
        if (s === '3' || s === '红色' || s === '红') return '红';
        return s;
    }

    /**
     * 读取 9 个字段，返回对象
     * - 隐藏字段（phone / producer / publishTime / serialNo）即使表单被 CSS 隐藏也会读出
     * - 但隐藏字段的值不可信：电话固定为 0871-67087127，制作人从 UserIdentity 取，发布时间留空（点击时填），序号留空（点击时生成）
     * - 等级字段支持数字（'1'/'2'/'3'）和中文（'黄'/'橙'/'红'/'黄色'/'橙色'/'红色'）双形态输入，统一映射为 '黄'/'橙'/'红'
     */
    function readForm() {
        var data = {};
        for (var i = 0; i < FIELDS.length; i++) {
            var f = FIELDS[i];
            var el = elements[f];
            data[f] = (el && el.value != null) ? String(el.value).trim() : '';
        }
        // 等级字段统一映射
        data.level = normalizeLevel(data.level);
        // 覆盖：固定电话 + 自动制作人（来自 UserIdentity）+ 发布时间/序号留空
        data.phone = FIXED_PHONE;
        data.producer = (global.UserIdentity && typeof global.UserIdentity.get === 'function')
            ? (global.UserIdentity.get() || '未署名')
            : '未署名';
        // publishTime / serialNo 保持空字符串，由 onScreenshot 在点击时填充
        return data;
    }

    /** 写入表单（空值保留为空字符串） */
    function fillForm(data) {
        if (!data) return;
        for (var i = 0; i < FIELDS.length; i++) {
            var f = FIELDS[i];
            var el = elements[f];
            if (el && data[f] != null) {
                // 等级字段：内部存储为 黄/橙/红 单字，输入框展示为 黄色/橙色/红色 完整名
                if (f === 'level') {
                    el.value = levelToDisplay(data[f]) || data[f];
                } else {
                    el.value = data[f];
                }
            }
        }
    }

    /** 校验：返回缺失的必填字段中文名数组 */
    function validate(data) {
        var missing = [];
        for (var i = 0; i < REQUIRED.length; i++) {
            var f = REQUIRED[i];
            if (!data[f]) missing.push(fieldLabel(f));
        }
        return missing;
    }

    /** 字段名 → 中文标签 */
    function fieldLabel(f) {
        return ({
            airport: '预警机场',
            level: '预警等级',
            phenomenon: '天气类型',
            serialNo: '发布序号',
            publishTime: '发布时间',
            phone: '气象席电话',
            current: '当前天气情况',
            forecast: '预警内容',
            producer: '制作人'
        })[f] || f;
    }

    /** 防抖：合并连续调用，仅执行最后一次 */
    function debounce(fn, delay) {
        var timer = null;
        return function () {
            var args = arguments, ctx = this;
            if (timer) clearTimeout(timer);
            timer = setTimeout(function () { fn.apply(ctx, args); }, delay);
        };
    }

    /** 安全调用 Logger，缺失时降级为 console */
    function logInfo(msg, detail) { try { Logger.info(msg, detail || ''); } catch (e) { console.log(msg, detail); } }
    function logWarn(msg, detail) { try { Logger.warn(msg, detail || ''); } catch (e) { console.warn(msg, detail); } }
    function logError(msg, detail) { try { Logger.error(msg, detail || ''); } catch (e) { console.error(msg, detail); } }

    /* ============================================================
     * 预览渲染
     * ============================================================ */

    /**
     * 给元素设置文本；若值为空则应用 placeholder 样式
     * @param {HTMLElement} el
     * @param {string} text
     * @param {string} placeholderText
     */
    function setText(el, text, placeholderText) {
        if (!el) return;
        if (text) {
            el.textContent = text;
            el.classList.remove('is-placeholder');
        } else {
            el.textContent = placeholderText || '—';
            el.classList.add('is-placeholder');
        }
    }

    /**
     * 渲染预览卡
     * - 设置 CSS 变量驱动标题背景色 / 文字色 / 现象色
     * - 校验失败时显示错误条（不阻断预览渲染）
     * @param {object} data
     */
    function renderPreview(data) {
        var preview = elements.preview;
        if (!preview) return;
        lastRenderData = data;

        // 颜色：根据预警等级切换
        var level = data.level;
        var colors = LEVEL_COLORS[level];
        if (colors) {
            preview.style.setProperty('--wt-bg', colors.bg);
            preview.style.setProperty('--wt-text', colors.text);
            preview.style.setProperty('--wt-phenomenon', colors.phenomenon);
        } else {
            // 无等级时使用橙色默认（沿用气象台模板默认色）
            preview.style.setProperty('--wt-bg', LEVEL_COLORS['橙'].bg);
            preview.style.setProperty('--wt-text', LEVEL_COLORS['橙'].text);
            preview.style.setProperty('--wt-phenomenon', LEVEL_COLORS['橙'].phenomenon);
        }

        // 文本填充 - 写入选中预览节点(Preview 后缀),避免误写表单 input 元素
        setText(elements.airportName, data.airport, '请填写...');
        setText(elements.levelName, level ? LEVEL_TEXT[level] + '预警' : '预警', '预警');
        setText(elements.phenomenonPreview, data.phenomenon, '天气类型');
        setText(elements.serial, data.serialNo, '—');
        setText(elements.publishTimePreview, data.publishTime, 'yyyy年M月d日HH:mm');
        setText(elements.phonePreview, data.phone, '—');
        setText(elements.currentPreview, data.current, '当前天气情况');
        setText(elements.forecastPreview, data.forecast, '预警内容');
        setText(elements.producerName, data.producer, '—');

        // 错误条
        var missing = validate(data);
        showError(missing);
    }

    /** 显示/隐藏错误条 */
    function showError(missing) {
        var el = elements.error;
        if (!el) return;
        if (missing && missing.length) {
            el.textContent = '请填写必填字段：' + missing.join('、');
            el.hidden = false;
        } else {
            el.textContent = '';
            el.hidden = true;
        }
    }

    /* ============================================================
     * 持久化
     * ============================================================ */

    /** 写入草稿（防抖） */
    var persistDebounced = debounce(function (data) {
        try {
            Storage.set(STORAGE_KEY, data);
        } catch (e) {
            logWarn('warning draft persist failed', e && e.message);
        }
    }, DEBOUNCE_MS);

    /** 立即写入（用于"刷新时间"按钮等需要强一致场景） */
    function persistImmediate(data) {
        try { Storage.set(STORAGE_KEY, data); }
        catch (e) { logWarn('warning draft persist failed', e && e.message); }
    }

    /**
     * 从 Storage 恢复草稿
     * 旧键 met_tool_warning_draft 不再读取，仅在首次发现时 warn 一次
     */
    function restore() {
        // 首次发现旧草稿：记录一次 warn
        if (!oldDraftLogged) {
            try {
                var oldVal = Storage.get(OLD_STORAGE_KEY);
                if (oldVal) {
                    logWarn('warning old draft ignored');
                }
            } catch (e) { /* ignore */ }
            oldDraftLogged = true;
        }

        var draft = null;
        try { draft = Storage.get(STORAGE_KEY); } catch (e) { draft = null; }
        if (draft) {
            fillForm(draft);
            // 发布时间/序号在草稿恢复时也清空,点击时再生成
            if (elements.publishTime) elements.publishTime.value = '';
            if (elements.serialNo) elements.serialNo.value = '';
            logInfo('warning draft restored');
        }
        // 不再默认填充发布时间,等待用户点击"一键截图"时自动生成
    }

    /* ============================================================
     * 事件
     * ============================================================ */

    /** 通用输入防抖回调：写草稿 + 重新渲染预览 */
    function onInputChange() {
        var data = readForm();
        persistDebounced(data);
        renderPreview(data);
    }

    /** 等级切换：立即更新预览（颜色敏感） */
    function onLevelChange() {
        var data = readForm();
        renderPreview(data);
        persistImmediate(data);
    }

    /** 刷新发布时间为当前时间 */
    function onRefreshTime() {
        if (elements.publishTime) {
            elements.publishTime.value = formatBeijingTime(new Date());
        }
        onInputChange();
        logInfo('warning publish time refreshed');
    }

    /** 机场名变更：电话已固定为 FIXED_PHONE，无需按机场映射，仅刷新预览 */
    function onAirportChange() {
        onInputChange();
    }

    /* ============================================================
     * 等级数字快捷输入
     * - 输入 '1' / '2' / '3' → 内部 level 立即变为 黄/橙/红 → 实时更新预览
     * - 已显示某等级再输入数字 → 切换为新等级
     * - 输入其他字符（'5' / 'a' / '黄' / '橙色' 等）→ 不修改内部 level（输入框保留用户输入）
     * - onBlur：若输入不是 '1'/'2'/'3' 也不是有效的中文（黄/橙/红/黄色/橙色/红色）→ 清空输入框
     * ============================================================ */

    /** 等级 input 输入事件：实时映射并刷新预览 */
    function onLevelInput() {
        var raw = (elements.level && elements.level.value != null) ? String(elements.level.value).trim() : '';
        // 用户输入 1/2/3 时，自动把输入框值替换为完整等级名（黄色/橙色/红色）
        if (raw === '1' || raw === '2' || raw === '3') {
            var displayName = levelToDisplay(normalizeLevel(raw));
            if (displayName && elements.level.value !== displayName) {
                elements.level.value = displayName;
            }
        }
        var data = readForm();
        // readForm 已自动映射 level；若 raw 不是 1/2/3，则内部 level 为空（输入框保留原值）
        // 但若 raw 是 '1'/'2'/'3' → 内部 level 必为 黄/橙/红
        if (raw === '1' || raw === '2' || raw === '3') {
            // 已经映射为 黄/橙/红，不需额外处理
        } else if (raw === '黄' || raw === '橙' || raw === '红' ||
                   raw === '黄色' || raw === '橙色' || raw === '红色') {
            // 兼容：用户输入中文等级
        }
        renderPreview(data);
        persistImmediate(data);
    }

    /** 等级 input 失焦事件：非 1/2/3 也非合法中文 → 清空 */
    function onLevelBlur() {
        if (!elements.level) return;
        var raw = String(elements.level.value || '').trim();
        if (!raw) return;
        if (raw === '1' || raw === '2' || raw === '3') return;
        if (raw === '黄' || raw === '橙' || raw === '红' ||
            raw === '黄色' || raw === '橙色' || raw === '红色') return;
        // 非法输入：清空
        elements.level.value = '';
        var data = readForm();
        renderPreview(data);
        persistImmediate(data);
    }

    /* ============================================================
     * 机场联想输入
     * - onInput：实时渲染联想下拉（最多 10 条）
     * - onBlur：延迟 200ms 后尝试规范化（city/ICAO/IATA → city）
     * ============================================================ */

    /** 联想防抖定时器 */
    var airportSuggestTimer = null;
    /** 失焦延迟定时器 */
    var airportBlurTimer = null;
    /** 联想当前活跃项索引（键盘上下选择用） */
    var airportActiveIdx = -1;
    /** 当前联想结果缓存（供键盘导航用） */
    var airportSuggestCache = [];

    /** 机场 input 输入事件：实时渲染联想下拉 */
    function onAirportInput() {
        if (airportSuggestTimer) clearTimeout(airportSuggestTimer);
        airportSuggestTimer = setTimeout(function () {
            airportSuggestTimer = null;
            var inputEl = elements.airport;
            if (!inputEl) return;
            var raw = String(inputEl.value || '').trim();
            if (!raw) {
                hideAirportSuggest();
                return;
            }
            if (!global.AirportTemplate ||
                typeof global.AirportTemplate.getAutocompleteMatches !== 'function') {
                hideAirportSuggest();
                return;
            }
            var matches = global.AirportTemplate.getAutocompleteMatches(raw, 10);
            renderAirportSuggest(matches);
        }, 80); // 80ms 防抖
    }

    /** 渲染联想下拉列表 */
    function renderAirportSuggest(matches) {
        var box = elements.airportSuggest;
        if (!box) return;
        airportSuggestCache = matches || [];
        airportActiveIdx = -1;
        if (!matches || matches.length === 0) {
            // 显示"无匹配"提示，便于用户感知
            box.innerHTML = '<div class="wt-airport-suggest-empty">无匹配机场</div>';
            box.hidden = false;
            return;
        }
        var html = '';
        for (var i = 0; i < matches.length; i++) {
            var m = matches[i];
            var codes = (m.icao || '') +
                ((m.icao && m.iata) ? ' / ' : '') +
                (m.iata || '');
            html += '<div class="wt-airport-suggest-item" data-city="' + escapeHtml(m.city) +
                '" data-icao="' + escapeHtml(m.icao || '') + '" role="option">' +
                '<span class="wt-as-name">' + escapeHtml(m.city) + '</span>' +
                '<span class="wt-as-codes">' + escapeHtml(codes) + '</span>' +
                '</div>';
        }
        box.innerHTML = html;
        box.hidden = false;
        // 绑定点击事件
        var items = box.querySelectorAll('.wt-airport-suggest-item');
        for (var j = 0; j < items.length; j++) {
            (function (item) {
                item.addEventListener('mousedown', function (e) {
                    // mousedown 先于 blur，避免 onBlur 误清空
                    e.preventDefault();
                    var city = item.getAttribute('data-city') || '';
                    selectAirport(city);
                });
            })(items[j]);
        }
    }

    /** 选中机场并填入输入框 */
    function selectAirport(city) {
        if (!city) {
            hideAirportSuggest();
            return;
        }
        if (elements.airport) {
            elements.airport.value = city;
        }
        hideAirportSuggest();
        // 同步电话 + 重渲染 + 持久化
        onAirportChange();
    }

    /** 隐藏联想下拉 */
    function hideAirportSuggest() {
        if (elements.airportSuggest) {
            elements.airportSuggest.hidden = true;
            elements.airportSuggest.innerHTML = '';
        }
        airportSuggestCache = [];
        airportActiveIdx = -1;
    }

    /** 机场 input 失焦事件：延迟规范化（避免与下拉点击冲突） */
    function onAirportBlur() {
        var inputEl = elements.airport;
        if (!inputEl) return;
        // 延迟 200ms：给联想下拉点击事件先执行的机会
        if (airportBlurTimer) clearTimeout(airportBlurTimer);
        airportBlurTimer = setTimeout(function () {
            airportBlurTimer = null;
            hideAirportSuggest();
            var raw = String(inputEl.value || '').trim();
            if (!raw) return;
            if (!global.AirportTemplate ||
                typeof global.AirportTemplate.resolveAirport !== 'function') {
                return;
            }
            var resolved = global.AirportTemplate.resolveAirport(raw);
            if (resolved && resolved !== raw) {
                inputEl.value = resolved;
            }
            // 同步电话 + 重渲染 + 持久化
            onAirportChange();
        }, 200);
    }

    /** 机场 input 键盘事件：上下选择 + Enter 确认 + Esc 关闭 */
    function onAirportKeydown(e) {
        if (!e) return;
        var box = elements.airportSuggest;
        if (!box || box.hidden) return;
        var key = e.key || e.code;
        if (key === 'ArrowDown') {
            e.preventDefault();
            airportActiveIdx = Math.min(airportActiveIdx + 1, airportSuggestCache.length - 1);
            updateAirportActive();
        } else if (key === 'ArrowUp') {
            e.preventDefault();
            airportActiveIdx = Math.max(airportActiveIdx - 1, 0);
            updateAirportActive();
        } else if (key === 'Enter') {
            if (airportActiveIdx >= 0 && airportActiveIdx < airportSuggestCache.length) {
                e.preventDefault();
                selectAirport(airportSuggestCache[airportActiveIdx].city);
            } else if (airportSuggestCache.length > 0) {
                e.preventDefault();
                selectAirport(airportSuggestCache[0].city);
            }
        } else if (key === 'Escape') {
            e.preventDefault();
            hideAirportSuggest();
        }
    }

    /** 更新联想下拉的活跃项视觉 */
    function updateAirportActive() {
        var box = elements.airportSuggest;
        if (!box) return;
        var items = box.querySelectorAll('.wt-airport-suggest-item');
        for (var i = 0; i < items.length; i++) {
            if (i === airportActiveIdx) {
                items[i].classList.add('is-active');
                // 滚动到可视区域
                items[i].scrollIntoView({ block: 'nearest' });
            } else {
                items[i].classList.remove('is-active');
            }
        }
    }

    /* ============================================================
     * 发布序号确认弹窗
     * - 打开 → 显示默认序号 + 绑定 +/-/确认/取消/ESC/backdrop
     * - 调整范围 [1, 999]
     * - 确认 → confirmSerial + 继续截图
     * - 取消/ESC/backdrop → 不消耗序号
     * ============================================================ */

    /** 弹窗当前显示的序号值（不含日期） */
    var serialModalCurrent = '';
    /** 弹窗回调（resolve = 确认序号；reject = 取消） */
    var serialModalResolver = null;
    var serialModalRejecter = null;
    /** 弹窗 ESC 监听器引用 */
    var serialModalEscHandler = null;
    /** 弹窗外点击监听器引用（mousedown 触发） */
    var serialModalOutsideClickHandler = null;

    /**
     * 打开序号确认弹窗
     * @param {string} initialSerial 默认序号（如 20260718001）
     * @returns {Promise<string>} 确认时 resolve(调整后序号)；取消时 reject({__cancelled:true})
     */
    function openSerialModal(initialSerial) {
        var modal = elements.serialModal;
        if (!modal) {
            // 弹窗 DOM 不存在：降级直接返回 initialSerial（不阻塞主流程）
            logWarn('warning serial modal missing, fallback to direct confirm');
            return Promise.resolve(initialSerial);
        }
        serialModalCurrent = initialSerial || getNextSerial();
        updateSerialDisplay(serialModalCurrent);

        modal.hidden = false;
        modal.setAttribute('aria-hidden', 'false');
        // 触发动画（强制 reflow）
        void modal.offsetWidth;

        var settle = function (confirmValue) {
            closeSerialModal();
            if (confirmValue) {
                if (serialModalResolver) {
                    serialModalResolver(confirmValue);
                }
            } else {
                if (serialModalRejecter) {
                    serialModalRejecter({ __cancelled: true });
                }
            }
            serialModalResolver = null;
            serialModalRejecter = null;
        };

        // 绑定一次性事件
        if (elements.serialMinus) {
            elements.serialMinus.onclick = function () { adjustSerial(-1); };
        }
        if (elements.serialPlus) {
            elements.serialPlus.onclick = function () { adjustSerial(+1); };
        }
        if (elements.serialConfirm) {
            elements.serialConfirm.onclick = function () { settle(serialModalCurrent); };
        }
        if (elements.serialCancel) {
            elements.serialCancel.onclick = function () { settle(null); };
        }
        // backdrop 点击关闭（兼容旧版[data-modal-close]节点，目前新版弹窗无 backdrop）
        var backdrops = modal.querySelectorAll('[data-modal-close]');
        for (var i = 0; i < backdrops.length; i++) {
            (function (bd) {
                bd.onclick = function () { settle(null); };
            })(backdrops[i]);
        }
        // 点击弹窗外部区域关闭（无 backdrop 时的兜底）
        serialModalOutsideClickHandler = function (e) {
            if (!modal || modal.hidden) return;
            var target = e.target;
            // 触发按钮本身也不关闭（让用户可以再次点击）
            if (elements.btnScreenshot && elements.btnScreenshot.contains(target)) return;
            if (modal.contains(target)) return;
            settle(null);
        };
        // 用 mousedown 而不是 click，避免与「+」「-」按钮的内部 click 冲突
        document.addEventListener('mousedown', serialModalOutsideClickHandler);
        // ESC 键监听
        serialModalEscHandler = function (e) {
            if (e && (e.key === 'Escape' || e.keyCode === 27)) {
                settle(null);
            }
        };
        document.addEventListener('keydown', serialModalEscHandler);

        // 返回 Promise
        return new Promise(function (resolve, reject) {
            serialModalResolver = resolve;
            serialModalRejecter = reject;
        });
    }

    /** 关闭弹窗 + 清理事件 */
    function closeSerialModal() {
        var modal = elements.serialModal;
        if (modal) {
            modal.hidden = true;
            modal.setAttribute('aria-hidden', 'true');
        }
        if (serialModalEscHandler) {
            document.removeEventListener('keydown', serialModalEscHandler);
            serialModalEscHandler = null;
        }
        if (serialModalOutsideClickHandler) {
            document.removeEventListener('mousedown', serialModalOutsideClickHandler);
            serialModalOutsideClickHandler = null;
        }
        // 清理按钮 onclick（避免内存泄漏）
        if (elements.serialMinus) elements.serialMinus.onclick = null;
        if (elements.serialPlus) elements.serialPlus.onclick = null;
        if (elements.serialConfirm) elements.serialConfirm.onclick = null;
        if (elements.serialCancel) elements.serialCancel.onclick = null;
        if (modal) {
            var backdrops = modal.querySelectorAll('[data-modal-close]');
            for (var i = 0; i < backdrops.length; i++) backdrops[i].onclick = null;
        }
    }

    /** 更新弹窗显示的序号 + 副标题 + 按钮 disabled 状态 */
    function updateSerialDisplay(serialValue) {
        if (!serialValue) return;
        var match = String(serialValue).match(/^(\d{8})(\d{3})$/);
        if (!match) return;
        serialModalCurrent = serialValue;
        var nnn = parseInt(match[2], 10);
        if (elements.serialDisplay) {
            elements.serialDisplay.textContent = serialValue;
        }
        if (elements.serialSuffix) {
            elements.serialSuffix.textContent = '今日第 ' + nnn + ' 份预警';
        }
        if (elements.serialMinus) {
            elements.serialMinus.disabled = (nnn <= 1);
        }
        if (elements.serialPlus) {
            elements.serialPlus.disabled = (nnn >= 999);
        }
    }

    /** 调整弹窗序号 ±1 */
    function adjustSerial(delta) {
        var match = String(serialModalCurrent || '').match(/^(\d{8})(\d{3})$/);
        if (!match) return;
        var date = match[1];
        var nnn = parseInt(match[2], 10);
        nnn = Math.max(1, Math.min(999, nnn + delta));
        updateSerialDisplay(date + String(nnn).padStart(3, '0'));
    }

    /** 一键截图（弹窗改造版） */
    function onScreenshot() {
        var data = readForm();
        var missing = validate(data);
        if (missing.length) {
            showError(missing);
            flashButton(elements.btnScreenshot, '请先完善必填项');
            logWarn('warning screenshot blocked: missing ' + missing.join(','));
            return;
        }

        var btn = elements.btnScreenshot;
        btn.disabled = true;

        // 打开序号弹窗：默认显示 getNextSerial()
        var defaultSerial = getNextSerial();
        var modalPromise = openSerialModal(defaultSerial);
        // 兼容：openSerialModal 可能同步 resolve（弹窗缺失场景）
        if (!modalPromise || typeof modalPromise.then !== 'function') {
            modalPromise = Promise.resolve(defaultSerial);
        }

        modalPromise.then(function (serial) {
            // 用户确认
            confirmSerial(serial);
            data.serialNo = serial;
            data.publishTime = getCurrentBeijingTime();
            if (elements.serialNo) elements.serialNo.value = serial;
            if (elements.publishTime) elements.publishTime.value = data.publishTime;
            renderPreview(data);

            // 上报到自建服务器（供其他软件读取）
            // 时机：用户点击「确认发布序号」后、截图之前；取消弹窗不会走到这里，故不会产生无效数据
            // 语义：尽力而为，失败仅记日志，不阻塞下方的截图与历史记录入库
            pushWarningReport(data);

            // 执行真正的截图（DOM → PNG Blob）
            // 注意：历史预警记录的添加移至 handleScreenshotBlob 剪贴板写入成功的回调中
            //       仅在截图成功复制到剪贴板后才入库，避免截图失败时产生无效记录
            if (typeof global.html2canvas !== 'function') {
                // 无 html2canvas：跳过截图
                return Promise.reject({ __skipped: true, message: 'html2canvas 未加载' });
            }
            // 先启动 DOM → PNG 渲染（耗时不确定），拿到 Blob 的 Promise
            var blobPromise = html2canvasCapture();
            // 关键：此刻仍处于用户点击「确认发布序号」的瞬时激活有效期内，
            // 先以「延迟渲染」方式发起剪贴板写入（Blob 由上面的 Promise 后续兑现），
            // 避免渲染耗时超过激活有效期后写入被浏览器拒绝而回退成下载
            var earlyWrite = startEarlyClipboardWrite(blobPromise);
            return blobPromise.then(function (blob) {
                return handleScreenshotBlob(blob, data, earlyWrite);
            });
        }).then(function () {
            // 截图流程结束（成功）：恢复按钮可用
            btn.disabled = false;
        }).catch(function (err) {
            if (err && err.__cancelled) {
                // 用户主动取消：立即恢复按钮可用，不显示失败提示
                btn.disabled = false;
                logInfo('warning screenshot cancelled by user');
            } else if (err && err.__skipped) {
                // 无 html2canvas：跳过截图，但按钮已禁用，要恢复
                btn.disabled = false;
                logInfo('warning screenshot skipped (no html2canvas)');
            } else {
                // 截图失败：提示 + 延迟恢复
                logError('warning screenshot failed', err && err.message);
                flashButton(btn, '截图失败');
                setTimeout(function () { btn.disabled = false; }, FLASH_MS);
            }
        });
    }

    /**
     * 调用 html2canvas 截取预览卡，返回 Blob
     * 说明：HTML 中已使用内嵌 base64 data URL 加载图片，
     *   data URL 为同源资源，不会污染 canvas
     * @returns {Promise<Blob>}
     */
    function html2canvasCapture() {
        if (typeof global.html2canvas !== 'function') {
            return Promise.reject(new Error('html2canvas 未加载'));
        }
        return global.html2canvas(elements.preview, {
            backgroundColor: '#ffffff',
            scale: 2,
            useCORS: true,
            logging: false
        }).then(function (canvas) {
            if (typeof canvas.toBlob !== 'function') {
                throw new Error('canvas.toBlob 不可用');
            }
            return new Promise(function (resolve, reject) {
                try {
                    canvas.toBlob(function (blob) {
                        if (!blob) {
                            return reject(new Error('canvas.toBlob 返回空（画布可能被污染）'));
                        }
                        resolve(blob);
                    }, 'image/png');
                } catch (e) {
                    logError('canvas.toBlob 异常', e && e.message);
                    reject(new Error('canvas.toBlob 执行失败：' + (e && e.message)));
                }
            });
        }).catch(function (err) {
            logError('html2canvas 捕获失败', err && err.message);
            throw err;
        });
    }

    /**
     * 是否具备图片剪贴板写入能力
     * @returns {boolean}
     */
    function isClipboardImageSupported() {
        return !!(global.navigator &&
            global.navigator.clipboard &&
            typeof global.navigator.clipboard.write === 'function' &&
            typeof global.ClipboardItem === 'function');
    }

    /** 延时指定毫秒（用于写入重试的退避等待） */
    function delay(ms) {
        return new Promise(function (resolve) { setTimeout(resolve, ms); });
    }

    /**
     * 提前发起剪贴板写入（延迟渲染）
     * 背景：Chromium 要求 clipboard.write 处于「瞬时用户激活」有效期内调用，
     *       而 html2canvas 渲染耗时不确定，Windows 慢机上可能超过有效期，
     *       写入被拒后原逻辑会把 PNG 下载到本地（非预期行为）。
     * 方案：在激活期内先提交 ClipboardItem，其值用 Promise 占位，
     *       浏览器会等 Promise 兑现后再落盘，从而不受渲染耗时影响。
     * @param {Promise<Blob>} blobPromise 渲染生成的 PNG Blob
     * @returns {Promise<void>|null} 写入结果；环境不支持延迟渲染时返回 null（由调用方走常规写入）
     */
    function startEarlyClipboardWrite(blobPromise) {
        if (!isClipboardImageSupported() || !blobPromise || typeof blobPromise.then !== 'function') {
            return null;
        }
        var writePromise;
        try {
            var item = new global.ClipboardItem({ 'image/png': blobPromise });
            writePromise = global.navigator.clipboard.write([item]);
        } catch (e) {
            // 少数环境不支持 Promise 形式的 ClipboardItem：交由常规写入处理
            logWarn('warning clipboard early write unsupported: ' + (e && e.message));
            return null;
        }
        if (!writePromise || typeof writePromise.then !== 'function') {
            return null;
        }
        // 预挂空 catch：渲染失败时该写入同样失败，先标记已处理避免 unhandled rejection，
        // 具体回退由调用方按写入结果决定
        writePromise.catch(function () { /* 由调用方处理 */ });
        return writePromise;
    }

    /**
     * 单次写入剪贴板
     * 说明：Chromium 要求承载页面处于聚焦状态，Windows 下窗口失焦
     *       （切换窗口、其他程序抢占焦点）时会被直接拒绝，
     *       因此写入前先尝试恢复焦点
     * @param {Blob} blob PNG Blob
     * @returns {Promise<void>} 失败时 reject 并携带原始原因
     */
    function writeBlobOnce(blob) {
        return new Promise(function (resolve, reject) {
            if (typeof document.hasFocus === 'function' && !document.hasFocus()) {
                try { global.focus(); } catch (e) { /* ignore */ }
            }
            var item;
            try {
                item = new global.ClipboardItem({ 'image/png': blob });
            } catch (e) {
                reject(new Error('ClipboardItem 构造失败：' + (e && e.message)));
                return;
            }
            try {
                global.navigator.clipboard.write([item]).then(resolve, function (err) {
                    reject(err || new Error('剪贴板写入被拒绝'));
                });
            } catch (e) {
                reject(e);
            }
        });
    }

    /**
     * 复制 PNG 到剪贴板（失败自动重试）
     * @description Windows 下写入失败多为瞬时故障（剪贴板被其他进程短暂占用等），
     *              退避重试可显著提升成功率；全部失败后由调用方回退为下载
     * @param {Blob} blob PNG Blob
     * @returns {Promise<void>} 全部尝试失败时 reject（携带最后一次错误）
     */
    function copyPngToClipboard(blob) {
        var attempt = 0;
        function run() {
            return writeBlobOnce(blob).catch(function (err) {
                if (attempt >= CLIPBOARD_MAX_ATTEMPTS - 1) {
                    throw err;
                }
                // 首次重试立即执行，后续按 CLIPBOARD_RETRY_DELAYS 退避
                // （attempt 最大为 CLIPBOARD_MAX_ATTEMPTS - 2，下标不会越界）
                var wait = CLIPBOARD_RETRY_DELAYS[attempt];
                attempt++;
                logWarn('warning clipboard write retry #' + attempt + ': ' + (err && err.message));
                return delay(wait).then(run);
            });
        }
        return run();
    }

    /**
     * 剪贴板复制成功后的收尾：写入历史预警记录并刷新卡片区
     * @description 历史记录仅在复制成功后才入库，避免产生无效记录；
     *              写入异常只记日志，不影响截图主流程
     * @param {object} data 表单数据
     */
    function addHistoryAfterCopy(data) {
        try {
            if (global.WarningRecordExporter &&
                typeof global.WarningRecordExporter.addRecord === 'function') {
                var addResult = global.WarningRecordExporter.addRecord(data);
                if (addResult && addResult.success) {
                    // 刷新历史预警卡片区
                    refreshHistory('after-screenshot');
                    logInfo('warning history added by screenshot: ' +
                        (addResult.dateStamp || ''));
                } else {
                    logWarn('warning history add by screenshot failed: ' +
                        (addResult && addResult.message));
                }
            } else {
                logWarn('WarningRecordExporter.addRecord unavailable, skip history add');
            }
        } catch (histErr) {
            logWarn('warning history add by screenshot exception', histErr && histErr.message);
        }
    }

    /**
     * 处理截图 Blob：优先写入剪贴板，全部尝试失败后才回退为下载
     * @param {Blob} blob PNG Blob
     * @param {object} data 表单数据（用于生成文件名与历史记录）
     * @param {Promise<void>|null} [earlyWrite] 激活期内提前发起的写入结果（见 startEarlyClipboardWrite）
     * @returns {Promise<void>}
     */
    function handleScreenshotBlob(blob, data, earlyWrite) {
        var btn = elements.btnScreenshot;
        // PNG 文件名沿用「时间+机场+等级+天气现象」格式（例: `2026年7月18日沈阳橙色预警（大风）.png`）
        var name = buildScreenshotFilename(data);

        if (!isClipboardImageSupported()) {
            // 环境不支持图片剪贴板：回退下载，不入库历史记录
            downloadBlob(blob, name);
            flashButton(btn, '已下载 PNG');
            logInfo('warning screenshot downloaded (no clipboard support)');
            return Promise.resolve();
        }

        // 优先复用激活期内提前写入的结果；失败则按当前 Blob 重试写入
        var copyPromise = (earlyWrite && typeof earlyWrite.then === 'function')
            ? earlyWrite.catch(function (err) {
                logWarn('warning clipboard early write failed: ' + (err && err.message));
                return copyPngToClipboard(blob);
            })
            : copyPngToClipboard(blob);

        return copyPromise.then(function () {
            // 剪贴板写入成功：先提示，再加入历史预警记录
            flashButton(btn, '已复制截图');
            logInfo('warning screenshot copied');
            addHistoryAfterCopy(data);
        }, function (err) {
            // 全部尝试失败：回退为下载（不入库历史记录）
            logWarn('warning clipboard write failed, fallback to download', err && err.message);
            downloadBlob(blob, name);
            flashButton(btn, '已下载 PNG');
        });
    }

    /**
     * 构造截图文件名：`yyyy年M月d日<机场><等级>预警（<天气现象>）.png`
     * 若发布时间为空则回退为当前日期
     * @param {object} data 表单数据
     * @returns {string} 完整文件名（含 .png 后缀）
     */
    function buildScreenshotFilename(data) {
        var d = new Date();
        if (data && data.publishTime) {
            // publishTime 形如 `2026年7月18日17:49`，截取日期部分
            var m = String(data.publishTime).match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
            if (m) {
                d = new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10));
            }
        }
        var datePart = d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日';
        var airport = (data && data.airport) ? data.airport : '机场';
        var level = (data && data.level) ? (LEVEL_TEXT[data.level] || data.level) : '预警';
        var phenomenon = (data && data.phenomenon) ? data.phenomenon : '';
        return datePart + airport + level + '预警' + (phenomenon ? '（' + phenomenon + '）' : '') + '.png';
    }

    /** 触发浏览器下载 Blob */
    function downloadBlob(blob, filename) {
        try {
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
        } catch (e) {
            logError('warning download failed', e && e.message);
        }
    }

    /**
     * 导出历史预警记录
     * - 仅导出"历史预警机场"模块已存储的全部历史记录（跨日期、按时间正序）
     * - 不再追加当前表单数据，不再消费发布序号，不再写入发布时间
     * - 入口传入 data=null + options.mode='only-existing' 区分于「先追加后导出」模式
     * - 当且仅当 chrome.storage.local 中没有历史记录时返回失败，提示「暂无历史预警记录可导出」
     */
    function onExportRecord() {
        var btn = elements.btnExportRecord;
        if (!btn) {
            logWarn('warning record export: button not found');
            return;
        }
        btn.disabled = true;

        try {
            if (!global.WarningRecordExporter) {
                throw new Error('WarningRecordExporter 未加载');
            }
            // 仅导出"历史预警机场"模块已存储的记录，不再追加当前表单数据
            var result = global.WarningRecordExporter.exportRecord(null, { mode: 'only-existing' });

            if (result && result.success) {
                flashButton(btn, '已导出记录');
                logInfo('warning record exported: ' + (result.filename || '') +
                    ' (rows: ' + (result.rowCount || 0) + ')');
                // 刷新历史预警机场卡片区
                refreshHistory('after-export');
            } else {
                var msg = (result && result.message) || '导出失败';
                flashButton(btn, msg);
                logWarn('warning record export failed: ' + msg);
            }
        } catch (err) {
            logError('warning record export exception', err && err.message);
            flashButton(btn, '导出失败');
        } finally {
            setTimeout(function () { btn.disabled = false; }, FLASH_MS);
        }
    }

    /** 按钮文字闪动提示 */
    function flashButton(btn, text) {
        if (!btn) return;
        var prev = btn.textContent;
        btn.textContent = text;
        setTimeout(function () { btn.textContent = prev; }, FLASH_MS);
    }

    /** 重置 */
    function onReset() {
        try {
            for (var i = 0; i < FIELDS.length; i++) {
                var f = FIELDS[i];
                if (elements[f]) elements[f].value = '';
            }
            try { Storage.remove(STORAGE_KEY); } catch (e) { /* ignore */ }
            // 序号计数器不重置,按当日累计
            var data = readForm();
            renderPreview(data);
            logInfo('warning form reset');
        } catch (e) {
            logError('warning reset failed', e && e.message);
        }
    }

    /* ============================================================
     * 事件绑定 & 初始化
     * ============================================================ */

    function bindEvents() {
        var form = elements.form;
        if (form) {
            form.addEventListener('input', onInputChange);
        }
        // 等级：input 事件实时映射 + blur 清空非法
        if (elements.level) {
            elements.level.addEventListener('input', onLevelInput);
            elements.level.addEventListener('blur', onLevelBlur);
        }
        // 机场：input 联想 + blur 规范化 + keydown 键盘导航
        if (elements.airport) {
            elements.airport.addEventListener('input', onAirportInput);
            elements.airport.addEventListener('blur', onAirportBlur);
            elements.airport.addEventListener('keydown', onAirportKeydown);
        }
        if (elements.btnScreenshot) {
            elements.btnScreenshot.addEventListener('click', onScreenshot);
        }
        if (elements.btnExportRecord) {
            elements.btnExportRecord.addEventListener('click', onExportRecord);
        }
        if (elements.btnReset) {
            elements.btnReset.addEventListener('click', onReset);
        }
        // 按钮 wt-refresh-time 已从 UI 移除(发布时间改为点击截图时自动填充)
    }

    /**
     * 缓存 DOM 元素引用
     * @returns {boolean} 是否所有必要元素都找到了
     */
    function cacheElements() {
        elements = {
            form: document.getElementById('wt-form'),
            airport: document.getElementById('wt-airport-input'),
            airportSuggest: document.getElementById('wt-airport-suggest'),
            level: document.getElementById('wt-level'),
            phenomenon: document.querySelector('#wt-form [name="phenomenon"]'),
            serialNo: document.querySelector('#wt-form [name="serialNo"]'),
            publishTime: document.getElementById('wt-publish-time'),
            phone: document.querySelector('#wt-form [name="phone"]'),
            current: document.querySelector('#wt-form [name="current"]'),
            forecast: document.querySelector('#wt-form [name="forecast"]'),
            producer: document.querySelector('#wt-form [name="producer"]'),

            preview: document.getElementById('wt-preview'),
            error: document.getElementById('wt-error'),
            btnScreenshot: document.getElementById('wt-screenshot'),
            btnExportRecord: document.getElementById('wt-export-record'),
            btnReset: document.getElementById('wt-reset'),
            btnRefreshTime: document.getElementById('wt-refresh-time'),

            // 序号弹窗
            serialModal: document.getElementById('wt-serial-modal'),
            serialDisplay: document.getElementById('wt-serial-display'),
            serialMinus: document.getElementById('wt-serial-minus'),
            serialPlus: document.getElementById('wt-serial-plus'),
            serialSuffix: document.getElementById('wt-serial-suffix'),
            serialConfirm: document.getElementById('wt-serial-confirm'),
            serialCancel: document.getElementById('wt-serial-cancel'),

            // 预览卡内子元素
            airportName: document.querySelector('.wt-airport-name'),
            levelName: document.querySelector('.wt-level-name'),
            phenomenonPreview: document.querySelector('.wt-phenomenon'),
            serial: document.querySelector('.wt-serial'),
            publishTimePreview: document.querySelector('.wt-publish-time'),
            phonePreview: document.querySelector('.wt-phone'),
            currentPreview: document.querySelector('.wt-current'),
            forecastPreview: document.querySelector('.wt-forecast'),
            producerName: document.querySelector('.wt-producer-name')
        };

        if (!elements.form || !elements.preview) {
            logError('warning template init failed: required DOM missing');
            return false;
        }
        return true;
    }

    function init() {
        try {
            if (!cacheElements()) return;
            bindEvents();
            restore();
            // 渲染初始预览
            renderPreview(readForm());
            // 初始化历史预警机场模块（按机场分组、扑克牌样式）
            initHistoryModule();
            logInfo('机场预警模板模块已初始化');
        } catch (e) {
            logError('warning template init exception', e && e.message);
        }
    }

    /**
     * 初始化历史预警机场模块
     * 独立 try/catch 避免单个模块失败影响主流程
     */
    function initHistoryModule() {
        try {
            if (!global.WarningHistoryModule || typeof global.WarningHistoryModule.init !== 'function') {
                logWarn('WarningHistoryModule not loaded, skip init');
                return;
            }
            global.WarningHistoryModule.init();
        } catch (e) {
            logError('history module init failed', e && e.message);
        }
    }

    /**
     * 刷新历史预警机场（截图/导出成功后调用）
     */
    function refreshHistory(trigger) {
        try {
            if (global.WarningHistoryModule && typeof global.WarningHistoryModule.render === 'function') {
                global.WarningHistoryModule.render(trigger || 'manual');
            }
        } catch (e) {
            logWarn('history module render failed', e && e.message);
        }
    }

    /**
     * 上报机场预警信息到自建服务器（供其他软件读取）
     * - 调用方不等待结果：尽力而为，失败只影响服务端数据，不影响本地截图与历史记录
     * - 模块未加载（server-config.local.js 缺失等）时静默跳过，由 pusher 内部记一次 warn 日志
     * - 兜底捕获同步异常，确保 pushWarning 抛错也不会中断截图主流程
     * @param {object} data 预警表单数据
     */
    function pushWarningReport(data) {
        try {
            if (!global.WarningReportPusher || typeof global.WarningReportPusher.pushWarning !== 'function') {
                logWarn('WarningReportPusher not loaded, skip server push');
                return;
            }
            // 返回的 Promise 在 pusher 内部已做全量兜底，这里再挂一次 catch 防止未处理拒绝
            global.WarningReportPusher.pushWarning(data).catch(function (e) {
                logWarn('warning report push unhandled', e && e.message);
            });
        } catch (e) {
            logWarn('warning report push exception', e && e.message);
        }
    }

    global.WarningTemplateModule = { init: init };
})(window);
