/**
 * Toast · Apple 风格轻提示（组件）
 * --------------------------------------------------------------------
 * 职责：在页面顶部居中弹出一条轻提示，用于反馈操作结果（成功/警告/失败）。
 * 设计语言：毛玻璃 / 大圆角 / 多层半透明 / 弹性缓动 / 微交互（样式见 toast.css）
 *
 * 设计要点：
 *   1. 零依赖：仅需 toast.css，容器与节点全部由本模块动态创建
 *   2. 不阻塞主流程：内部全量 try/catch，组件异常时降级为 console 并返回 null
 *   3. 自动清理：按时长自动离场，离场动画结束后从 DOM 移除
 *   4. 堆叠控制：同时最多 3 条，超出时移除最早一条，避免遮挡页面
 *   5. 无障碍：容器带 role="status" / aria-live="polite"；支持 prefers-reduced-motion
 *
 * 暴露对象：window.Toast
 *   - show(message, type, duration): HTMLElement|null
 *       message  提示文案（空文案不展示）
 *       type     info（默认）/ success / warn / error
 *       duration 展示时长（毫秒），不传按类型取默认值
 *
 * 用法：
 *   Toast.show('已复制到剪贴板', 'success');
 *   Toast.show('预警信息上报失败，请检查网络', 'error');
 */
(function (global) {
    'use strict';

    /* ============================================================
     * 常量
     * ============================================================ */

    /** 容器类名（与 toast.css 保持一致） */
    var CLASS_HOST = 'mt-toast-host';
    /** 单条提示类名 */
    var CLASS_ITEM = 'mt-toast';
    /** 可见态类名 */
    var CLASS_VISIBLE = 'is-visible';
    /** 离场态类名 */
    var CLASS_LEAVING = 'is-leaving';

    /** 允许的类型，非法值统一回退为 info */
    var TYPES = { info: true, success: true, warn: true, error: true };

    /** 各类型默认展示时长（毫秒）：警告与错误停留更久，便于阅读 */
    var DEFAULT_DURATION = { info: 2600, success: 2600, warn: 3600, error: 4500 };

    /** 离场动画时长（毫秒），需与 toast.css 中 .is-leaving 的 transition-duration 一致 */
    var LEAVE_DURATION_MS = 220;

    /** 同时最多展示条数 */
    var MAX_VISIBLE = 3;

    /* ============================================================
     * 内部实现
     * ============================================================ */

    /** 顶部容器节点（懒创建并复用） */
    var host = null;

    /** requestAnimationFrame 降级（极旧环境用 setTimeout 兜底） */
    function nextFrame(callback) {
        if (typeof global.requestAnimationFrame === 'function') {
            global.requestAnimationFrame(callback);
            return;
        }
        global.setTimeout(callback, 16);
    }

    /**
     * 确保容器存在
     * @returns {HTMLElement} 容器节点
     */
    function ensureHost() {
        if (host && host.parentNode) return host;
        host = global.document.createElement('div');
        host.className = CLASS_HOST;
        host.setAttribute('role', 'status');
        host.setAttribute('aria-live', 'polite');
        global.document.body.appendChild(host);
        return host;
    }

    /** 从 DOM 移除节点 */
    function removeNode(node) {
        if (node && node.parentNode) node.parentNode.removeChild(node);
    }

    /**
     * 触发离场动画并延后移除
     * @param {HTMLElement} node Toast 节点
     * @returns {void}
     */
    function dismiss(node) {
        if (!node || node.__mtLeaving) return;
        node.__mtLeaving = true;
        if (node.__mtTimer) {
            global.clearTimeout(node.__mtTimer);
            node.__mtTimer = null;
        }
        node.classList.add(CLASS_LEAVING);
        global.setTimeout(function () { removeNode(node); }, LEAVE_DURATION_MS);
    }

    /**
     * 展示一条 Toast
     * @param {string} message 提示文案（为空时不展示）
     * @param {string} [type] 类型：info / success / warn / error，默认 info
     * @param {number} [duration] 展示时长（毫秒），不传按类型取默认值
     * @returns {HTMLElement|null} Toast 节点；未展示时返回 null
     */
    function show(message, type, duration) {
        var text = message == null ? '' : String(message);
        if (!text) return null;

        try {
            var hostEl = ensureHost();
            var kind = TYPES[type] ? type : 'info';
            var life = (typeof duration === 'number' && duration > 0)
                ? duration
                : (DEFAULT_DURATION[kind] || 2600);

            // 超量时先触发最早一条的离场，保证同时最多 MAX_VISIBLE 条
            var items = hostEl.querySelectorAll('.' + CLASS_ITEM);
            for (var i = 0; i + MAX_VISIBLE <= items.length; i++) {
                dismiss(items[i]);
            }

            var node = global.document.createElement('div');
            node.className = CLASS_ITEM + ' mt-toast--' + kind;
            node.textContent = text;
            hostEl.appendChild(node);

            // 下一帧再加可见类，确保入场过渡能够触发
            nextFrame(function () { node.classList.add(CLASS_VISIBLE); });
            node.__mtTimer = global.setTimeout(function () { dismiss(node); }, life);
            return node;
        } catch (e) {
            // 组件异常不得影响业务主流程：降级为控制台输出
            try { global.console.warn('[Toast] 展示失败：' + (e && e.message)); } catch (e2) { /* ignore */ }
            return null;
        }
    }

    global.Toast = { show: show };
})(window);