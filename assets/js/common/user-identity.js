/**
 * 用户身份模块（UserIdentity）
 * --------------------------------------------------------------------
 * 设计目标
 *   1. 首次打开页面时，若无用户名则自动弹出输入弹窗
 *   2. 右上角展示用户胶囊，便于查看与切换
 *   3. 用户名仅用于后续发布气象产品时的署名，无需验证
 *   4. 持久化：chrome.storage.local 优先，降级 localStorage
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

    /** 元素引用缓存 */
    var elements = {};

    /** 当前用户名（内存态） */
    var currentName = '';

    /* ============================================================
     * 持久化：chrome.storage.local 优先，降级 localStorage
     * 与 translator.js 的处理方式保持一致
     * ============================================================ */

    function localKey() { return 'met_tool:' + STORAGE_KEY; }

    function readFromLocalStorage() {
        try {
            var raw = global.localStorage.getItem(localKey());
            if (!raw) return '';
            var v = JSON.parse(raw);
            return (v && typeof v.name === 'string') ? v.name : '';
        } catch (e) {
            return '';
        }
    }

    function writeToLocalStorage(name) {
        try {
            var payload = { name: name, updatedAt: new Date().toISOString() };
            global.localStorage.setItem(localKey(), JSON.stringify(payload));
        } catch (e) { /* ignore */ }
    }

    /** 读取用户名（异步） */
    function load() {
        return new Promise(function (resolve) {
            try {
                if (global.chrome && chrome.storage && chrome.storage.local) {
                    chrome.storage.local.get(STORAGE_KEY, function (data) {
                        var v = data && data[STORAGE_KEY];
                        if (v && typeof v.name === 'string' && v.name.length > 0) {
                            resolve(v.name);
                        } else {
                            // 降级读取
                            resolve(readFromLocalStorage());
                        }
                    });
                    return;
                }
            } catch (e) { /* fall through */ }
            resolve(readFromLocalStorage());
        });
    }

    /** 写入用户名（异步） */
    function save(name) {
        return new Promise(function (resolve) {
            var payload = { name: name, updatedAt: new Date().toISOString() };
            var done = function (ok) {
                // 始终同步写入 localStorage 作为冗余备份
                writeToLocalStorage(name);
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
        renderPill();

        load().then(function (name) {
            currentName = name || '';
            renderPill();
            if (global.Logger) {
                Logger.info('用户身份已加载：' + (currentName || '(未设置)'));
            }
            // 首次访问（无用户名）→ 自动弹出
            if (!currentName) {
                // 略微延迟以让页面其它资源先就位
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
