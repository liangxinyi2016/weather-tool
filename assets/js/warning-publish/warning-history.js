/**
 * 「历史预警机场」展示模块
 * --------------------------------------------------------------------
 * 设计目标：
 *   1. 读取 WarningRecordExporter 中已存储的全部预警记录
 *   2. 按"预警机场"名称分组
 *   3. 以扑克牌样式展示（每张卡 = 一份预警记录）
 *   4. 支持单条删除（右上角 × 按钮）
 *   5. 支持全部清空（顶部"清空"按钮）
 *
 * 数据来源：chrome.storage.local 键 `met_tool_warning_record_log`
 *   结构：{ '20260718': [[row1], [row2], ...], '20260719': [...] }
 *   row 是 11 列布局：序号/日期/影响机场/预警等级/天气类型/预警内容/发布时间/发生时段/预报时长/制作人/发布序号
 *
 * UI 规范：
 *   - Apple Design Language：毛玻璃 / 大圆角 / 多层半透明 / 弹性缓动
 *   - 卡片堆叠效果：同一机场多条记录按顺序向下错位 6px
 *   - 顶部彩条按预警等级着色（红 / 橙 / 黄）
 */
(function (global) {
    'use strict';

    /* ============================================================
     * 常量
     * ============================================================ */

    /** 等级中文名映射 */
    var LEVEL_TEXT = { '红': '红色', '橙': '橙色', '黄': '黄色' };

    /** 等级颜色（与 warning-template.js 保持一致） */
    var LEVEL_COLORS = {
        '红': { bg: '#E74C3C', soft: 'rgba(231, 76, 60, 0.22)' },
        '橙': { bg: '#F89F48', soft: 'rgba(248, 159, 72, 0.26)' },
        '黄': { bg: '#FFEE00', soft: 'rgba(255, 238, 0, 0.32)' }
    };

    /** 单条记录最大显示字符（超出截断） */
    var MAX_FORECAST_CHARS = 80;

    /* ============================================================
     * 内部状态
     * ============================================================ */

    var rootEl = null;             // 根容器 #wt-history
    var listEl = null;             // 卡片堆叠列表容器 #wt-history-list
    var emptyEl = null;            // 空状态展示
    var statEl = null;             // 统计区（机场数/记录数）
    var btnClearAll = null;        // 全部清空按钮
    var lastRenderTrigger = null;  // 最近一次渲染的触发原因（debug）

    // 自定义确认弹窗（全部清空）
    var confirmModalEl = null;     // 弹窗容器 #wt-confirm-clear-modal
    var confirmMaskEl = null;      // 遮罩 #wt-confirm-clear-mask
    var confirmOkEl = null;        // 确认按钮
    var confirmCancelEl = null;    // 取消按钮
    var confirmMessageEl = null;   // 消息文本
    var confirmResolver = null;    // Promise resolve 回调
    var confirmEscHandler = null;  // ESC 键监听器引用

    /* ============================================================
     * 工具函数
     * ============================================================ */

    /** HTML 转义 */
    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    /** 数字补零 */
    function pad2(n) { return n < 10 ? '0' + n : '' + n; }

    /**
     * yyyyMMdd → yyyy-MM-dd 显示用
     */
    function formatDate(stamp) {
        if (!stamp || stamp.length !== 8) return stamp || '';
        return stamp.slice(0, 4) + '-' + stamp.slice(4, 6) + '-' + stamp.slice(6, 8);
    }

    /**
     * 截断过长的预警内容
     */
    function truncate(s, max) {
        s = String(s == null ? '' : s);
        if (s.length <= max) return s;
        return s.slice(0, max) + '…';
    }

    /**
     * 等级字符 → 等级颜色对象
     * 容错处理：'红' / '红色' / 'Red' 都视为红色
     */
    function getLevelStyle(level) {
        var k = normalizeLevelKey(level);
        return LEVEL_COLORS[k] || { bg: '#9ca3af', soft: 'rgba(156, 163, 175, 0.12)' };
    }

    /**
     * 等级字符 → 等级显示文本
     * 输入 '红' / '红色' / 'Red' / undefined → 输出去掉前后空格的字符串
     */
    function getLevelText(level) {
        var k = normalizeLevelKey(level);
        if (k && LEVEL_TEXT[k]) return LEVEL_TEXT[k];
        return level || '—';
    }

    /**
     * 归一化等级字段为单字 key
     * '红' / '红色' → '红'
     * '橙' / '橙色' → '橙'
     * '黄' / '黄色' → '黄'
     * 其它 → 原值（trim 后）
     */
    function normalizeLevelKey(level) {
        var s = String(level == null ? '' : level).trim();
        if (!s) return '';
        if (s === '红' || s === '红色' || /^red$/i.test(s)) return '红';
        if (s === '橙' || s === '橙色' || /^orange$/i.test(s)) return '橙';
        if (s === '黄' || s === '黄色' || /^yellow$/i.test(s)) return '黄';
        return s;
    }

    /* ============================================================
     * 数据加工
     * ============================================================ */

    /**
     * 读取并按机场分组
     * @returns {Array<{airport:string, level:string, records:Array}>}
     *          按"最新预警时间"倒序：每个机场取最新记录的时间作排序键
     */
    function getGroupedRecords() {
        var Exporter = global.WarningRecordExporter;
        if (!Exporter || typeof Exporter.getAllLogs !== 'function') return [];

        var all = Exporter.getAllLogs();
        if (!all.length) return [];

        // groupKey = 机场名
        var groups = {};
        all.forEach(function (entry) {
            var row = entry.row || [];
            var airport = String(row[2] || '').trim() || '未知机场';
            var level = String(row[3] || '').trim() || '黄';
            // 发布序号作为排序键（yyyyMMddNNN，越大越新）
            var serial = String(row[10] || '').trim() || entry.dateStamp + '000';
            if (!groups[airport]) {
                groups[airport] = {
                    airport: airport,
                    level: level,
                    latestSerial: serial,
                    records: []
                };
            }
            groups[airport].records.push({
                dateStamp: entry.dateStamp,
                rowIndex: entry.rowIndex,
                row: row,
                serial: serial
            });
            // 更新"最近一次预警"的等级（用于卡片顶部彩条）
            if (serial > groups[airport].latestSerial) {
                groups[airport].latestSerial = serial;
                groups[airport].level = level;
            }
        });

        // 转换为数组并按 latestSerial 倒序
        var result = Object.keys(groups).map(function (k) { return groups[k]; });
        result.sort(function (a, b) {
            if (a.latestSerial > b.latestSerial) return -1;
            if (a.latestSerial < b.latestSerial) return 1;
            return 0;
        });

        // 每个机场内部记录按时间倒序
        result.forEach(function (g) {
            g.records.sort(function (a, b) {
                if (a.serial > b.serial) return -1;
                if (a.serial < b.serial) return 1;
                return 0;
            });
        });

        return result;
    }

    /* ============================================================
     * 渲染
     * ============================================================ */

    /**
     * 渲染单个机场卡组（含多条预警）
     */
    function renderAirportGroup(group) {
        var level = group.level;
        var style = getLevelStyle(level);
        var cards = group.records.map(function (rec, idx) {
            return renderRecordCard(rec, idx, group.records.length, level, style);
        }).join('');

        return [
            '<div class="wt-hg" data-airport="' + esc(group.airport) + '">',
            '  <div class="wt-hg-head" style="--lv-bg:' + style.bg + '; --lv-soft:' + style.soft + '">',
            '    <span class="wt-hg-lv" style="background:' + style.bg + '">' + esc(getLevelText(level)) + '</span>',
            '    <span class="wt-hg-name">' + esc(group.airport) + '</span>',
            '    <span class="wt-hg-count">' + group.records.length + ' 份</span>',
            '  </div>',
            '  <div class="wt-hg-stack">',
            '    ' + cards,
            '  </div>',
            '</div>'
        ].join('\n');
    }

    /**
     * 渲染单条预警卡（扑克牌样式）
     */
    function renderRecordCard(rec, idx, total, level, style) {
        var row = rec.row || [];
        // 11 列布局：[序号, 日期, 影响机场, 预警等级, 天气类型, 预警内容, 发布时间, 发生时段, 预报时长, 制作人, 发布序号]
        var publishDate = formatDate(String(row[1] || rec.dateStamp));
        var publishTime = String(row[6] || '').trim();
        var phenomenon = String(row[4] || '').trim() || '—';
        var forecast = truncate(String(row[5] || '').trim(), MAX_FORECAST_CHARS);
        var period = String(row[7] || '').trim();
        var duration = String(row[8] || '').trim();
        var producer = String(row[9] || '').trim();
        var serialNo = String(row[10] || '').trim();

        // 堆叠偏移：除第一张外每张向右下偏移 6px
        var stackStyle = '';
        if (idx > 0) {
            var offset = Math.min(idx, 4) * 6; // 最多累计 24px
            stackStyle = ' style="transform: translate(' + offset + 'px, ' + offset + 'px)"';
        }

        // CSS 变量：把等级色传到卡片，供内部各元素统一引用
        var levelVars = '--lv-bg:' + style.bg + ';--lv-soft:' + style.soft + ';--lv-strong:' + hexToRgba(style.bg, 0.22) + ';' + stackStyle.replace(/^ style="|"/g, '');

        return [
            '<div class="wt-card" data-date="' + esc(rec.dateStamp) + '" data-row="' + rec.rowIndex + '" style="' + esc(levelVars) + '">',
            '  <div class="wt-card-stripe"></div>',
            '  <button class="wt-card-close" type="button" data-action="delete" ',
            '          data-date="' + esc(rec.dateStamp) + '" data-row="' + rec.rowIndex + '" ',
            '          aria-label="删除此条预警" title="删除此条预警">×</button>',
            '  <div class="wt-card-row1">',
            '    <div class="wt-card-pub">',
            '      <span class="wt-card-pub-date">' + esc(publishDate) + '</span>',
            '      <span class="wt-card-pub-time">' + esc(publishTime) + '</span>',
            '    </div>',
            '    <div class="wt-card-phenomenon">' + esc(phenomenon) + '</div>',
            '  </div>',
            '  <div class="wt-card-forecast">' + esc(forecast) + '</div>',
            '  <div class="wt-card-meta">',
            '    <span class="wt-card-tag">时段 ' + esc(period || '—') + '</span>',
            '    <span class="wt-card-tag">时长 ' + esc(duration || '—') + '</span>',
            '    <span class="wt-card-tag">制作 ' + esc(producer || '—') + '</span>',
            '  </div>',
            '  <div class="wt-card-foot">',
            '    <span class="wt-card-serial">' + esc(serialNo || '—') + '</span>',
            '    <span class="wt-card-stack-idx">' + (idx + 1) + ' / ' + total + '</span>',
            '  </div>',
            '</div>'
        ].join('\n');
    }

    /**
     * 将 hex 颜色 (#RRGGBB) 转为带 alpha 的 rgba
     * @param {string} hex
     * @param {number} alpha 0~1
     */
    function hexToRgba(hex, alpha) {
        if (!hex || hex[0] !== '#' || hex.length !== 7) {
            return 'rgba(0, 0, 0, ' + alpha + ')';
        }
        var r = parseInt(hex.slice(1, 3), 16);
        var g = parseInt(hex.slice(3, 5), 16);
        var b = parseInt(hex.slice(5, 7), 16);
        if (isNaN(r) || isNaN(g) || isNaN(b)) {
            return 'rgba(0, 0, 0, ' + alpha + ')';
        }
        return 'rgba(' + r + ', ' + g + ', ' + b + ', ' + alpha + ')';
    }

    /**
     * 渲染统计区
     */
    function renderStat(groups) {
        if (!statEl) return;
        var totalRecords = groups.reduce(function (s, g) { return s + g.records.length; }, 0);
        statEl.textContent = '共 ' + groups.length + ' 个机场 / ' + totalRecords + ' 条历史预警';
    }

    /**
     * 主渲染入口
     * @param {string} [trigger] 触发原因（debug 用：init / after-export / after-delete / after-clear-all / manual）
     */
    function render(trigger) {
        lastRenderTrigger = trigger || 'manual';
        if (!rootEl) return;

        var groups = getGroupedRecords();

        // 更新统计
        renderStat(groups);

        // 切换空状态 / 列表
        if (!groups.length) {
            if (listEl) listEl.innerHTML = '';
            if (emptyEl) emptyEl.hidden = false;
            if (btnClearAll) btnClearAll.disabled = true;
            return;
        }
        if (emptyEl) emptyEl.hidden = true;
        if (btnClearAll) btnClearAll.disabled = false;

        // 渲染所有机场组
        if (listEl) listEl.innerHTML = groups.map(renderAirportGroup).join('\n');
    }

    /* ============================================================
     * 事件处理
     * ============================================================ */

    /**
     * 单条删除
     */
    function onDeleteClick(e) {
        var btn = e.target.closest('[data-action="delete"]');
        if (!btn) return;
        e.preventDefault();
        e.stopPropagation();
        var date = btn.getAttribute('data-date');
        var rowIdx = parseInt(btn.getAttribute('data-row'), 10);
        if (!date || isNaN(rowIdx)) return;

        // 找到对应的卡片，做"翻牌消失"动画
        var card = btn.closest('.wt-card');
        if (card) {
            card.classList.add('is-removing');
        }

        // 延迟 280ms 后真正从存储中删除（让动画跑完）
        setTimeout(function () {
            var Exporter = global.WarningRecordExporter;
            if (!Exporter) return;
            var ok = Exporter.removeRecord(date, rowIdx);
            if (ok) {
                logInfo('warning history: removed record ' + date + '#' + rowIdx);
                render('after-delete');
            } else {
                logWarn('warning history: removeRecord returned false');
                if (card) card.classList.remove('is-removing');
            }
        }, 280);
    }

    /**
     * 全部清空（使用自定义毛玻璃确认弹窗，避免浏览器原生 confirm 与 UI 不统一）
     */
    function onClearAll() {
        if (!global.WarningRecordExporter) return;
        var groups = getGroupedRecords();
        if (!groups.length) return;
        var total = groups.reduce(function (s, g) { return s + g.records.length; }, 0);

        // 弹出自定义确认弹窗，等待用户选择
        openClearConfirm(total).then(function (ok) {
            if (!ok) return;

            // 先把所有卡片加"翻牌"动画
            var cards = rootEl ? rootEl.querySelectorAll('.wt-card') : [];
            cards.forEach(function (c, i) {
                setTimeout(function () { c.classList.add('is-removing'); }, i * 20);
            });

            setTimeout(function () {
                var success = global.WarningRecordExporter.clearAllLogs();
                if (success) {
                    logInfo('warning history: cleared all ' + total + ' records');
                    render('after-clear-all');
                } else {
                    logWarn('warning history: clearAllLogs returned false');
                    cards.forEach(function (c) { c.classList.remove('is-removing'); });
                }
            }, Math.min(cards.length * 20 + 280, 1200));
        });
    }

    /**
     * 打开自定义确认弹窗（"全部清空"专用）
     * @param {number} total 待删除的记录总数
     * @returns {Promise<boolean>} true=确认删除 / false=取消
     */
    function openClearConfirm(total) {
        // DOM 缺失时降级为浏览器原生 confirm
        if (!confirmModalEl || !confirmMaskEl) {
            try {
                return Promise.resolve(global.confirm('确定清空全部 ' + total + ' 条历史预警？此操作不可撤销。'));
            } catch (e) {
                return Promise.resolve(true);
            }
        }

        // 更新消息文本（动态插入记录数）
        if (confirmMessageEl) {
            confirmMessageEl.textContent = '此操作将删除全部 ' + total + ' 条历史预警记录，且不可撤销。';
        }

        // 显示弹窗 + 遮罩
        confirmModalEl.hidden = false;
        confirmModalEl.setAttribute('aria-hidden', 'false');
        confirmMaskEl.hidden = false;
        confirmMaskEl.setAttribute('aria-hidden', 'false');

        // 触发弹性缓动动画（强制 reflow）
        var dialog = confirmModalEl.querySelector('.wt-confirm-dialog');
        if (dialog) {
            void dialog.offsetWidth;
        }

        // 默认聚焦"取消"按钮（防止误操作触发确认）
        setTimeout(function () {
            if (confirmCancelEl && !confirmCancelEl.disabled) {
                try { confirmCancelEl.focus(); } catch (e) { /* ignore */ }
            }
        }, 50);

        // ESC 键监听
        confirmEscHandler = function (e) {
            if (e && (e.key === 'Escape' || e.keyCode === 27)) {
                closeClearConfirm(false);
            }
        };
        document.addEventListener('keydown', confirmEscHandler);

        return new Promise(function (resolve) {
            confirmResolver = resolve;
        });
    }

    /**
     * 关闭自定义确认弹窗
     * @param {boolean} ok true=确认 / false=取消
     */
    function closeClearConfirm(ok) {
        if (confirmModalEl) {
            confirmModalEl.hidden = true;
            confirmModalEl.setAttribute('aria-hidden', 'true');
        }
        if (confirmMaskEl) {
            confirmMaskEl.hidden = true;
            confirmMaskEl.setAttribute('aria-hidden', 'true');
        }
        if (confirmEscHandler) {
            document.removeEventListener('keydown', confirmEscHandler);
            confirmEscHandler = null;
        }
        if (confirmResolver) {
            var r = confirmResolver;
            confirmResolver = null;
            r(!!ok);
        }
    }

    /* ============================================================
     * 日志
     * ============================================================ */

    function logInfo() {
        if (global.Logger && typeof global.Logger.info === 'function') {
            global.Logger.info.apply(global.Logger, ['[warning-history]'].concat(Array.prototype.slice.call(arguments)));
        }
    }
    function logWarn() {
        if (global.Logger && typeof global.Logger.warn === 'function') {
            global.Logger.warn.apply(global.Logger, ['[warning-history]'].concat(Array.prototype.slice.call(arguments)));
        }
    }

    /* ============================================================
     * 初始化
     * ============================================================ */

    /**
     * @param {Object} [opts]
     * @param {HTMLElement} [opts.root] 根容器，默认查询 #wt-history
     * @param {HTMLElement} [opts.list] 列表容器，默认 #wt-history-list
     * @param {HTMLElement} [opts.empty] 空状态节点，默认 #wt-history-empty
     * @param {HTMLElement} [opts.stat] 统计节点，默认 #wt-history-stat
     * @param {HTMLElement} [opts.btnClearAll] 清空按钮，默认 #wt-history-clear-all
     */
    function init(opts) {
        opts = opts || {};
        rootEl = opts.root || document.getElementById('wt-history');
        listEl = opts.list || document.getElementById('wt-history-list');
        emptyEl = opts.empty || document.getElementById('wt-history-empty');
        statEl = opts.stat || document.getElementById('wt-history-stat');
        btnClearAll = opts.btnClearAll || document.getElementById('wt-history-clear-all');

        // 全部清空确认弹窗
        confirmModalEl = document.getElementById('wt-confirm-clear-modal');
        confirmMaskEl = document.getElementById('wt-confirm-clear-mask');
        confirmOkEl = document.getElementById('wt-confirm-clear-ok');
        confirmCancelEl = document.getElementById('wt-confirm-clear-cancel');
        confirmMessageEl = document.getElementById('wt-confirm-clear-message');

        if (!rootEl) {
            logWarn('init skipped: #wt-history not found');
            return false;
        }

        // 事件绑定（一次性）
        if (listEl) {
            listEl.addEventListener('click', onDeleteClick);
        }
        if (btnClearAll) {
            btnClearAll.addEventListener('click', onClearAll);
        }

        // 确认弹窗事件绑定
        if (confirmOkEl) {
            confirmOkEl.addEventListener('click', function () { closeClearConfirm(true); });
        }
        if (confirmCancelEl) {
            confirmCancelEl.addEventListener('click', function () { closeClearConfirm(false); });
        }
        if (confirmMaskEl) {
            // 点击遮罩关闭（视为取消）
            confirmMaskEl.addEventListener('click', function () { closeClearConfirm(false); });
        }

        render('init');
        return true;
    }

    /* ============================================================
     * 暴露 API
     * ============================================================ */

    global.WarningHistoryModule = {
        init: init,
        render: render,
        getGroupedRecords: getGroupedRecords,
        // 内部方法暴露给测试
        _renderAirportGroup: renderAirportGroup,
        _renderRecordCard: renderRecordCard
    };
})(window);
