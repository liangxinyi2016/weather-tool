/**
 * 应用主入口
 * - Tab 切换与高亮（含滑动指示器动画）
 * - 当前 Tab 持久化
 * - 顶部导航栏滚动视觉变化
 * - 初始化各业务模块
 * - 绑定页脚日志查看/下载
 */
(function (global) {
    'use strict';

    var STORAGE_KEY_ACTIVE_TAB = 'met_tool_active_tab';

    var tabButtons = [];
    var panels = {};
    var tabsIndicator = null;
    var tabsEl = null;

    /**
     * 更新滑动指示器位置
     * @param {HTMLElement} activeTab 当前激活的 tab 按钮
     */
    function updateIndicator(activeTab) {
        if (!tabsIndicator || !activeTab) return;

        var tabsRect = tabsEl.getBoundingClientRect();
        var tabRect = activeTab.getBoundingClientRect();

        // 计算指示器位置（相对于 tabs 容器）
        var left = tabRect.left - tabsRect.left - 4;  // 减去 padding
        var width = tabRect.width;

        // 设置指示器位置和宽度
        tabsIndicator.style.width = width + 'px';
        tabsIndicator.style.transform = 'translateX(' + left + 'px)';
    }

    /**
     * 初始化滑动指示器
     */
    function initTabsIndicator() {
        if (!tabsEl) return;

        // 创建指示器元素
        tabsIndicator = document.createElement('div');
        tabsIndicator.className = 'tabs-indicator';
        tabsEl.insertBefore(tabsIndicator, tabsEl.firstChild);

        // 初始定位到第一个 active tab
        var activeTab = tabsEl.querySelector('.tab.active');
        if (activeTab) {
            // 延迟一帧，确保布局已完成
            requestAnimationFrame(function () {
                updateIndicator(activeTab);
            });
        }

        // 窗口大小变化时更新指示器
        window.addEventListener('resize', function () {
            var currentActive = tabsEl.querySelector('.tab.active');
            if (currentActive) {
                updateIndicator(currentActive);
            }
        });
    }

    /**
     * 切换 Tab
     * @param {string} name
     */
    function activate(name) {
        if (!panels[name]) return;

        var activeBtn = null;
        // 切换高亮
        for (var i = 0; i < tabButtons.length; i++) {
            var btn = tabButtons[i];
            var match = btn.getAttribute('data-tab') === name;
            btn.classList.toggle('active', match);
            btn.setAttribute('aria-selected', match ? 'true' : 'false');
            if (match) activeBtn = btn;
        }

        // 更新滑动指示器位置
        if (activeBtn) {
            updateIndicator(activeBtn);
        }

        // 切换内容
        Object.keys(panels).forEach(function (k) {
            panels[k].classList.toggle('hidden', k !== name);
            // 强制重新触发动画
            if (k === name) {
                panels[k].style.animation = 'none';
                // eslint-disable-next-line no-unused-expressions
                panels[k].offsetHeight; // reflow
                panels[k].style.animation = '';
            }
        });

        // 持久化
        try { Storage.set(STORAGE_KEY_ACTIVE_TAB, name); } catch (e) { /* ignore */ }
        Logger.info('切换 Tab: ' + name);
    }

    /**
     * 初始化顶部导航栏滚动效果
     */
    function initTopbarScroll() {
        var topbar = document.getElementById('topbar');
        if (!topbar) return;

        var lastScroll = 0;
        var ticking = false;

        function updateScrollState() {
            var currentScroll = window.pageYOffset || document.documentElement.scrollTop;

            if (currentScroll > 10) {
                topbar.classList.add('is-scrolled');
            } else {
                topbar.classList.remove('is-scrolled');
            }

            lastScroll = currentScroll;
            ticking = false;
        }

        window.addEventListener('scroll', function () {
            if (!ticking) {
                requestAnimationFrame(updateScrollState);
                ticking = true;
            }
        }, { passive: true });
    }

    /**
     * 初始化 Tab 切换
     */
    function initTabs() {
        tabsEl = document.getElementById('tabs');
        if (!tabsEl) return;

        tabButtons = Array.prototype.slice.call(tabsEl.querySelectorAll('.tab'));
        tabButtons.forEach(function (btn) {
            btn.addEventListener('click', function () {
                var name = btn.getAttribute('data-tab');
                activate(name);
            });
        });

        // 收集面板
        var panelEls = document.querySelectorAll('[data-panel]');
        panelEls.forEach(function (el) {
            panels[el.getAttribute('data-panel')] = el;
        });

        // 初始化滑动指示器
        initTabsIndicator();

        // 恢复上次选择
        var saved = null;
        try { saved = Storage.get(STORAGE_KEY_ACTIVE_TAB); } catch (e) { /* ignore */ }
        if (saved && panels[saved]) {
            activate(saved);
        } else {
            activate('warning');
        }
    }

    /**
     * 初始化页脚日志入口
     */
    function initLogUI() {
        var overlay = document.getElementById('log-overlay');
        var body = document.getElementById('log-body');
        var count = document.getElementById('log-count');
        var viewBtn = document.getElementById('view-log');
        var dlBtn = document.getElementById('download-log');
        var closeBtn = document.getElementById('log-close');

        function render() {
            var logs = Logger.getAll();
            count.textContent = logs.length;
            body.innerHTML = logs.map(function (e) {
                var cls = 'lvl-' + e.level;
                return '<div class="' + cls + '">[' + e.ts + '] [' + e.level.toUpperCase() + '] ' +
                    escapeHtml(e.message) + (e.detail ? ' ' + escapeHtml(e.detail) : '') + '</div>';
            }).join('');
            body.scrollTop = body.scrollHeight;
        }

        function openLog() {
            render();
            overlay.hidden = false;
        }

        function closeLog() { overlay.hidden = true; }

        if (viewBtn) viewBtn.addEventListener('click', openLog);
        if (closeBtn) closeBtn.addEventListener('click', closeLog);
        if (overlay) overlay.addEventListener('click', function (e) {
            if (e.target === overlay) closeLog();
        });
        if (dlBtn) dlBtn.addEventListener('click', function () {
            var text = Logger.toText();
            Exporter.downloadText(text, 'app_' + formatStamp(new Date()) + '.log');
            Logger.info('下载日志文件');
        });

        // 监听新日志以便面板打开时实时刷新
        Logger.onChange(function (entry) {
            if (entry === null) { if (!overlay.hidden) render(); return; }
            if (!overlay.hidden) render();
        });
    }

    function escapeHtml(s) {
        return String(s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    function formatStamp(d) {
        var p = function (n) { return n < 10 ? '0' + n : '' + n; };
        return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '_' +
            p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
    }

    /**
     * 应用初始化
     */
    function boot() {
        Logger.info('应用启动');
        // 用户身份模块需在 Tab 切换之前初始化：首次进入时它会判断是否需要弹出用户名弹窗
        if (global.UserIdentity) global.UserIdentity.init();
        initTabs();
        // 初始化顶部导航栏滚动效果
        initTopbarScroll();
        // 业务模块初始化
        if (global.WarningTemplateModule) global.WarningTemplateModule.init();
        if (global.WindDustModule) global.WindDustModule.init();
        if (global.NextDayRiskModule) global.NextDayRiskModule.init();
        if (global.WeatherTranslatorUI) global.WeatherTranslatorUI.init();
        if (global.TopbarClock) global.TopbarClock.init();
        if (global.Mascot) global.Mascot.init();
        initLogUI();
        Logger.info('应用初始化完成');
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
})(window);
