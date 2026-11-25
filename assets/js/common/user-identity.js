/**
 * 用户身份模块（UserIdentity）
 * --------------------------------------------------------------------
 * 设计目标
 *   1. 首次打开页面时，若无用户名则自动弹出输入弹窗
 *   2. 右上角展示用户胶囊，便于查看与切换
 *   3. 用户名仅用于后续发布气象产品时的署名，无需验证
 *   4. 持久化：chrome.storage.local 优先，降级 localStorage
 *   5. 每日北京时间 00:01 自动退出登录（清除已保存的用户身份并要求重新输入）；
 *      若页面关闭期间已跨过 00:01，则下次打开时同样视为已退出
 *
 * 暴露对象：window.UserIdentity
 *   - init()                       // 初始化 UI 与数据
 *   - get()                        // 获取当前用户名
 *   - isSet()                      // 是否已设置
 *   - set(name, opts)              // 设置用户名
 *   - open()                       // 主动打开弹窗
 */
(function (global) {
    'use strict';

    /** 持久化键名 */
    var STORAGE_KEY = 'met_tool_user_identity';

    /** 用户名最大长度（超过则截断） */
    var MAX_LEN = 20;

    /** 每日自动退出的北京时间点：00:01（相对当日 0 点的毫秒偏移） */
    var DAILY_LOGOUT_OFFSET_MS = 60 * 1000;

    /** 北京时间固定为 UTC+8 */
    var BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;

    /** 一天的毫秒数 */
    var DAY_MS = 24 * 60 * 60 * 1000;

    /** 元素引用缓存 */
    var elements = {};

    /** 当前用户名（内存态） */
    var currentName = '';

    /** 当前会话的自动退出时刻（时间戳，毫秒） */
    var expiresAt = 0;

    /** 自动退出定时器句柄 */
    var logoutTimer = null;

    /* ============================================================
     * 持久化：chrome.storage.local 优先，降级 localStorage
     * 与 translator.js 的处理方式保持一致
     * ============================================================ */

    function localKey() { return 'met_tool:' + STORAGE_KEY; }

    /**
     * 计算下一次自动退出时刻
     * 规则：取 fromMs 之后最近的北京时间 00:01，与运行环境的本地时区无关
     * @param {number} fromMs 起始时间戳（毫秒）
     * @returns {number} 下一次 00:01（北京时间）对应的时间戳（毫秒）
     */
    function nextLogoutTimestamp(fromMs) {
        var t = Number(fromMs);
        if (!isFinite(t) || t <= 0) t = Date.now();

        // 平移为“北京时区纪元”，使按天取整等价于北京时间当天 0 点
        var beijing = t + BEIJING_OFFSET_MS;
        var dayStart = Math.floor(beijing / DAY_MS) * DAY_MS;
        var candidate = dayStart + DAILY_LOGOUT_OFFSET_MS;
        // 已过当日 00:01 则顺延到次日
        if (candidate <= beijing) candidate += DAY_MS;
        return candidate - BEIJING_OFFSET_MS;
    }

    /** 读取 localStorage 中的身份载荷（作为 chrome.storage 的冗余备份） */
    function readFromLocalStorage() {
        try {
            var raw = global.localStorage.getItem(localKey());
            if (!raw) return null;
            var v = JSON.parse(raw);
            if (!v || typeof v.name !== 'string') return null;
            return v;
        } catch (e) {
            return null;
        }
    }

    function writeToLocalStorage(name, payload) {
        try {
            global.localStorage.setItem(localKey(), JSON.stringify(payload));
        } catch (e) { /* ignore */ }
    }

    /** 解析载荷：补齐缺失的自动退出时刻，兼容历史数据 */
    function normalizePayload(payload) {
        var p = payload || {};
        var name = (typeof p.name === 'string') ? p.name : '';

        var exp = Number(p.expiresAt);
        if (!isFinite(exp) || exp <= 0) {
            // 历史数据缺少 expiresAt：按 updatedAt 推算，缺失时按当前时间推算
            var updated = Date.parse(p.updatedAt || '');
            exp = nextLogoutTimestamp(isFinite(updated) ? updated : Date.now());
        }
        return { name: name, expiresAt: exp };
    }

    /**
     * 读取用户身份（异步）
     * @returns {Promise<{name: string, expiresAt: number}>}
     */
    function load() {
        return new Promise(function (resolve) {
            try {
                if (global.chrome && chrome.storage && chrome.storage.local) {
                    chrome.storage.local.get(STORAGE_KEY, function (data) {
                        var v = data && data[STORAGE_KEY];
                        if (v && typeof v.name === 'string' && v.name.length > 0) {
                            resolve(normalizePayload(v));
                        } else {
                            // 降级读取
                            resolve(normalizePayload(readFromLocalStorage()));
                        }
                    });
                    return;
                }
            } catch (e) { /* fall through */ }
            resolve(normalizePayload(readFromLocalStorage()));
        });
    }

    /** 写入用户名（异步），同时记录本次会话的自动退出时刻 */
    function save(name) {
        var now = Date.now();
        var payload = {
            name: name,
            updatedAt: new Date(now).toISOString(),
            expiresAt: nextLogoutTimestamp(now)
        };
        expiresAt = payload.expiresAt;
        scheduleLogout();

        return new Promise(function (resolve) {
            var done = function (ok) {
                // 始终同步写入 localStorage 作为冗余备份
                writeToLocalStorage(name, payload);
                resolve(ok);
            };
            try {
                if (global.chrome && chrome.storage && chrome.storage.local) {
                    var obj = {}; obj[STORAGE_KEY] = payload;
                    chrome.storage.local.set(obj, function () { done(true); });
                    return;
                }
            } catch (e) { /* fall through */ }
            done(true);
        });
    }

    /** 清除已持久化的用户身份（chrome.storage.local + localStorage） */
    function clearStored() {
        return new Promise(function (resolve) {
            var done = function () {
                try { global.localStorage.removeItem(localKey()); } catch (e) { /* ignore */ }
                resolve();
            };
            try {
                if (global.chrome && chrome.storage && chrome.storage.local) {
                    chrome.storage.local.remove(STORAGE_KEY, done);
                    return;
                }
            } catch (e) { /* fall through */ }
            done();
        });
    }

    /* ============================================================
     * 每日 00:01 自动退出
     * ============================================================ */

    function clearLogoutTimer() {
        if (logoutTimer) {
            global.clearTimeout(logoutTimer);
            logoutTimer = null;
        }
    }

    /** 按当前会话的退出时刻安排定时器（无用户名时不需要） */
    function scheduleLogout() {
        clearLogoutTimer();
        if (!currentName || !expiresAt) return;

        var delay = expiresAt - Date.now();
        if (delay < 0) delay = 0;
        logoutTimer = global.setTimeout(handleDailyLogout, delay + 20);
    }

    /** 定时器回调：未到点（如系统时间回拨）则重新排期，到点则退出 */
    function handleDailyLogout() {
        logoutTimer = null;
        if (!currentName) return;
        if (Date.now() < expiresAt) {
            scheduleLogout();
            return;
        }
        autoLogout();
    }

    /** 执行自动退出：清空身份、提示用户并重新弹出用户名弹窗 */
    function autoLogout() {
        currentName = '';
        expiresAt = 0;
        clearLogoutTimer();
        renderPill();
        clearStored();

        if (global.Logger) Logger.info('已按每日 00:01 规则自动退出登录，用户身份已清除');
        if (global.Toast) global.Toast.show('已自动退出登录，请重新输入用户名', 'warn');

        // 与首次访问一致：延迟弹出，等页面其它资源就位
        global.setTimeout(openModal, 200);
    }

    /** 页面重新可见时补一次检查，避免后台标签页定时器被节流导致漏判 */
    function bindLifecycle() {
        document.addEventListener('visibilitychange', function () {
            if (document.hidden) return;
            if (currentName && expiresAt && Date.now() >= expiresAt) autoLogout();
        });
    }

    /* ============================================================
     * 公共 API
     * ============================================================ */

    function get() { return currentName; }

    function isSet() { return !!currentName; }

    function set(name) {
        var trimmed = (name == null ? '' : String(name)).trim().slice(0, MAX_LEN);
        currentName = trimmed;
        renderPill();
        return save(trimmed).then(function (ok) {
            if (global.Logger) {
                if (ok) {
                    Logger.info('用户身份已更新：' + (trimmed || '(空)'));
                } else {
                    Logger.warn('用户身份保存失败');
                }
            }
            return ok;
        });
    }

    /* ============================================================
     * UI 渲染
     * ============================================================ */

    /** 取首字符（中文取首字，英文取首字母并大写） */
    function initialOf(name) {
        if (!name) return '?';
        var ch = name.charAt(0);
        // 中文字符范围
        if (/[\u4e00-\u9fa5\u3400-\u4dbf]/.test(ch)) return ch;
        return ch.toUpperCase();
    }

    function renderPill() {
        if (!elements.pill) return;
        elements.pill.hidden = false;
        if (currentName) {
            elements.pillName.textContent = currentName;
            elements.pillInitial.textContent = initialOf(currentName);
            elements.pill.setAttribute('title', '当前用户：' + currentName + '（点击修改）');
        } else {
            elements.pillName.textContent = '未设置';
            elements.pillInitial.textContent = '?';
            elements.pill.setAttribute('title', '点击设置用户名');
        }
    }

    function showError(msg) {
        if (!elements.error) return;
        elements.error.textContent = msg;
        elements.error.hidden = !msg;
    }

    function openModal() {
        if (!elements.modal) return;
        elements.input.value = currentName || '';
        showError('');
        elements.modal.hidden = false;
        // 强制 reflow 后添加 show 类，触发过渡动画
        // eslint-disable-next-line no-unused-expressions
        elements.modal.offsetHeight;
        elements.modal.classList.add('show');
        // 延迟聚焦，等动画开始后体验更好
        setTimeout(function () {
            try {
                elements.input.focus();
                elements.input.select();
            } catch (e) { /* ignore */ }
        }, 80);
        if (global.Logger) Logger.info('打开用户名弹窗');
    }

    function closeModal() {
        if (!elements.modal) return;
        elements.modal.classList.remove('show');
        // 等过渡动画结束再隐藏，避免跳变
        setTimeout(function () {
            elements.modal.hidden = true;
            showError('');
        }, 240);
    }

    function onSave() {
        var v = (elements.input.value || '').trim();
        if (!v) {
            showError('用户名不能为空');
            try { elements.input.focus(); } catch (e) { /* ignore */ }
            return;
        }
        if (v.length > MAX_LEN) v = v.slice(0, MAX_LEN);
        set(v).then(function () {
            closeModal();
        });
    }

    /* ============================================================
     * 事件绑定
     * ============================================================ */

    function bind() {
        // 胶囊：打开弹窗
        elements.pill.addEventListener('click', openModal);

        // 关闭按钮
        elements.btnClose.addEventListener('click', closeModal);
        // 取消按钮
        elements.btnCancel.addEventListener('click', closeModal);
        // 保存按钮
        elements.btnSave.addEventListener('click', onSave);

        // 输入框：键盘交互
        elements.input.addEventListener('keydown', function (e) {
            if (e.key === 'Enter') {
                e.preventDefault();
                onSave();
            } else if (e.key === 'Escape') {
                e.preventDefault();
                closeModal();
            }
        });

        // 输入框：限制最大长度（粘贴超长时截断）
        elements.input.addEventListener('input', function () {
            if (elements.input.value.length > MAX_LEN) {
                elements.input.value = elements.input.value.slice(0, MAX_LEN);
            }
            // 有内容时清空错误提示
            if (elements.input.value.trim() && !elements.error.hidden) {
                showError('');
            }
        });

        // 点击遮罩关闭
        elements.modal.addEventListener('click', function (e) {
            if (e.target === elements.modal) closeModal();
        });
    }

    function collectElements() {
        elements.pill = document.getElementById('user-pill');
        elements.pillName = document.getElementById('user-pill-name');
        elements.pillInitial = document.getElementById('user-pill-initial');
        elements.modal = document.getElementById('user-modal');
        elements.input = document.getElementById('user-input');
        elements.error = document.getElementById('user-error');
        elements.btnSave = document.getElementById('user-save');
        elements.btnCancel = document.getElementById('user-cancel');
        elements.btnClose = document.getElementById('user-close');
    }

    /* ============================================================
     * 初始化
     * ============================================================ */

    function init() {
        collectElements();

        if (!elements.pill || !elements.modal) {
            if (global.Logger) Logger.warn('[UserIdentity] UI 元素未找到，跳过初始化');
            return;
        }

        bind();
        bindLifecycle();
        renderPill();

        load().then(function (session) {
            // 页面关闭期间已跨过北京时间 00:01 → 视为已退出登录
            if (session.name && Date.now() >= session.expiresAt) {
                autoLogout();
                return;
            }

            currentName = session.name || '';
            expiresAt = session.expiresAt;
            renderPill();
            scheduleLogout();

            if (global.Logger) {
                Logger.info('用户身份已加载：' + (currentName || '(未设置)'));
            }
            // 首次访问（无用户名）→ 自动弹出
            if (!currentName) {
                setTimeout(openModal, 200);
            }
        });

        if (global.Logger) Logger.info('用户身份模块已初始化');
    }

    global.UserIdentity = {
        init: init,
        get: get,
        isSet: isSet,
        set: set,
        open: openModal
    };
})(window);
