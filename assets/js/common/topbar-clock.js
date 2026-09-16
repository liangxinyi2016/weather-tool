/**
 * 顶部时钟模块（TopbarClock）
 * --------------------------------------------------------------------
 * 设计目标
 *   1. 在顶部标题栏（"气象业务辅助工具"标题右侧）展示实时时钟：日期 + 时:分
 *   2. 时分采用翻页时钟（Flip Clock）样式，数字变化时触发翻页动画
 *
 * 暴露对象：window.TopbarClock
 *   - init()   // 初始化时钟
 */
(function (global) {
    'use strict';

    /** 元素引用缓存 */
    var elements = {};

    /** 定时器句柄 */
    var clockTimer = null;

    /* ============================================================
     * 时钟渲染
     * ============================================================ */

    function pad(n) { return n < 10 ? '0' + n : '' + n; }

    /** 更新单个翻页数字段：值变化时触发翻页动画 */
    function setSeg(el, value) {
        if (!el) return;
        var text = String(value);
        if (el.textContent === text) return;
        // 触发翻页动画
        el.classList.remove('flipping');
        // eslint-disable-next-line no-unused-expressions
        el.offsetHeight; // 强制 reflow 以重置动画
        el.textContent = text;
        el.classList.add('flipping');
        // 动画结束后清除类，避免残留
        var cls = function () { el.classList.remove('flipping'); };
        setTimeout(cls, 360);
    }

    function renderClock(now) {
        var h = pad(now.getHours());
        var m = pad(now.getMinutes());
        setSeg(elements.h1, h.charAt(0));
        setSeg(elements.h2, h.charAt(1));
        setSeg(elements.m1, m.charAt(0));
        setSeg(elements.m2, m.charAt(1));

        if (elements.date) {
            var y = now.getFullYear();
            var mo = now.getMonth() + 1;
            var d = now.getDate();
            elements.date.textContent = y + '/' + pad(mo) + '/' + pad(d);
            elements.date.title = y + '年' + mo + '月' + d + '日';
        }
    }

    function startClock() {
        if (clockTimer) { clearInterval(clockTimer); clockTimer = null; }
        var tick = function () {
            try { renderClock(new Date()); } catch (e) { /* ignore */ }
        };
        tick();
        clockTimer = setInterval(tick, 1000);
    }

    /* ============================================================
     * 初始化
     * ============================================================ */

    function collectElements() {
        elements.h1 = document.getElementById('flip-h1');
        elements.h2 = document.getElementById('flip-h2');
        elements.m1 = document.getElementById('flip-m1');
        elements.m2 = document.getElementById('flip-m2');
        elements.date = document.getElementById('clock-date');
    }

    function init() {
        collectElements();
        startClock();
        if (global.Logger) Logger.info('顶部时钟模块已初始化');
    }

    global.TopbarClock = {
        init: init
    };
})(window);
