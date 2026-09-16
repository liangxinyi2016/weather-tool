/* ============================================================
 * SegmentedControl · Apple 风格分段控件（单选）
 * --------------------------------------------------------------------
 * 依赖：
 *   - segmented-control.css（本目录下）
 *   - 无外部库
 *
 * 用法一：自动初始化（推荐）
 *   <div class="sgc" data-sgc data-sgc-init="next" data-sgc-name="dateRole">
 *     <button type="button" class="sgc-item" data-sgc-value="day">当日</button>
 *     <button type="button" class="sgc-item" data-sgc-value="next">次日</button>
 *     <button type="button" class="sgc-item" data-sgc-value="after">后日</button>
 *   </div>
 *   （页面加载后 SDKOMContentLoaded 自动扫描 [data-sgc] 并初始化）
 *
 * 用法二：手动创建
 *   var ctrl = new SegmentedControl(el, {
 *       name: 'dateRole',
 *       init: 'next',
 *       onChange: function (value, index, el) { ... }
 *   });
 *
 * 对外 API：
 *   SegmentedControl.get(domNode)     取已绑定实例
 *   SegmentedControl.initAll()        手动扫描并初始化全部 [data-sgc]
 *   ctrl.getValue() -> string|null    当前值
 *   ctrl.getIndex() -> number|-1       当前选中索引
 *   ctrl.setValue(value)               切换选中项（触发 onChange，含 CSS 动画）
 *   ctrl.getOption(value) -> button|null
 * ============================================================ */
(function (global) {
    'use strict';

    /** 记录 domNode → 实例 的映射，便于 get() 复用 */
    var registry = {};

    /** 唯一计数，生成 name 回退名 */
    var uid = 0;

    /**
     * 构造函数
     * @param {Element} host 外层 .sgc 容器
     * @param {Object} [opts] { name, init, onChange, getValue }
     */
    function SegmentedControl(host, opts) {
        if (!host) throw new Error('[SegmentedControl] host 元素不能为空');
        this.host = host;
        this.opts = opts || {};
        this.items = Array.prototype.slice.call(host.querySelectorAll('.sgc-item'));
        this.track = host.querySelector('.sgc-track');
        this.name = this.opts.name || host.getAttribute('data-sgc-name') || ('sgc_' + (++uid));
        this._onChange = typeof this.opts.onChange === 'function' ? this.opts.onChange : null;

        // 建轨道（若结构未手动放置，则自动插入）
        if (!this.track) {
            this.track = document.createElement('div');
            this.track.className = 'sgc-track';
            host.insertBefore(this.track, host.firstChild);
        }

        this._bindEvents();

        // 初始选中：优先 opts.init，其次 data-sgc-init，默认选中第一项
        var initVal = this.opts.init || host.getAttribute('data-sgc-init');
        if (!initVal && this.items.length > 0) initVal = this.items[0].getAttribute('data-sgc-value');
        this._select(initVal, true);

        // 缓存到 registry
        if (host.id) registry[host.id] = this;
        if (!host.dataset) host.dataset = {};
        host.dataset.sgcBound = 'true';
    }

    /* ---------------- 内部 ---------------- */

    /** 绑定选项点击 + 窗口尺寸变化时重排滑块 */
    SegmentedControl.prototype._bindEvents = function () {
        var self = this;
        this.items.forEach(function (item) {
            item.addEventListener('click', function () {
                self._select(item.getAttribute('data-sgc-value'), false);
            });
        });
        // 容器尺寸变化（选项删改/窗口缩放）时同步滑块与禁用态
        if (typeof ResizeObserver === 'function') {
            this._ro = new ResizeObserver(function () { self._place(); self._applyEnabled(); });
            this._ro.observe(this.host);
        } else {
            this._onResize = function () { self._place(); };
            window.addEventListener('resize', this._onResize);
        }
    };

    /** 根据 DOM 状态更新禁用态（.sgc-disabled 类） */
    SegmentedControl.prototype._applyEnabled = function () {
        var disabled = this.host.hasAttribute('disabled') || this.host.classList.contains('sgc-disabled');
        this.items.forEach(function (item) {
            item.disabled = disabled;
            item.setAttribute('aria-disabled', disabled ? 'true' : 'false');
        });
    };

    /** 切换选中：更新 class / aria-selected / 表单值 / 滑块位置 */
    SegmentedControl.prototype._select = function (value, isInit) {
        var self = this;
        var targetIndex = -1;
        this.items.forEach(function (item, idx) {
            var v = item.getAttribute('data-sgc-value');
            var active = (v === value);
            item.classList.toggle('sgc-active', active);
            item.setAttribute('aria-selected', active ? 'true' : 'false');
            if (active) targetIndex = idx;
        });

        this._currentValue = (targetIndex >= 0) ? value : null;
        this._currentIndex = targetIndex;

        // 同步隐藏表单字段，便于作为普通表单值提交
        this._syncHiddenField();

        // 强制回流后再定位，确保滑块动画基于新状态起点
        requestAnimationFrame(function () {
            self._place();
        });

        if (this._onChange && !isInit) {
            this._onChange(this._currentValue, targetIndex, this.items[targetIndex] || null);
        }
    };

    /** 同步隐藏 input[name] 值，供表单获取 */
    SegmentedControl.prototype._syncHiddenField = function () {
        if (!this._hiddenEl) {
            this._hiddenEl = this.host.querySelector('input[name="' + this.name + '"]');
            if (!this._hiddenEl) {
                this._hiddenEl = document.createElement('input');
                this._hiddenEl.type = 'hidden';
                this._hiddenEl.name = this.name;
                this.host.appendChild(this._hiddenEl);
            }
        }
        this._hiddenEl.value = this._currentValue || '';
    };

    /** 计算滑块几何：宽度 = 当前项宽度，左移 = 前序项宽度之和 */
    SegmentedControl.prototype._place = function () {
        if (!this.track || this._currentIndex < 0 || this._currentIndex >= this.items.length) return;
        var target = this.items[this._currentIndex];
        var left = 0;
        for (var i = 0; i < this._currentIndex; i++) left += this.items[i].offsetWidth;
        this.track.style.width = target.offsetWidth + 'px';
        this.track.style.transform = 'translateX(' + left + 'px)';
    };

    /* ---------------- 对外 API ---------------- */

    /** 当前值（字符串）或 null */
    SegmentedControl.prototype.getValue = function () {
        return this._currentValue || null;
    };

    /** 当前选中索引；未选中返回 -1 */
    SegmentedControl.prototype.getIndex = function () {
        return this._currentIndex;
    };

    /** 按值切换选中，触发 onChange（非初始化场景） */
    SegmentedControl.prototype.setValue = function (value) {
        this._select(value, false);
    };

    /** 静默同步选中值：更新激活态与滑块，但不触发 onChange（供外部状态联动，避免回调死循环） */
    SegmentedControl.prototype.syncValue = function (value) {
        this._select(value, true);
    };

    /** 按值取对应按钮元素 */
    SegmentedControl.prototype.getOption = function (value) {
        for (var i = 0; i < this.items.length; i++) {
            if (this.items[i].getAttribute('data-sgc-value') === value) return this.items[i];
        }
        return null;
    };

    /* ---------------- 静态方法 ---------------- */

    SegmentedControl.get = function (host) {
        if (!host) return null;
        if (typeof host === 'string') host = document.getElementById(host);
        return host && registry[host.id] ? registry[host.id] : null;
    };

    SegmentedControl.initAll = function () {
        var nodes = document.querySelectorAll('[data-sgc]:not([data-sgc-bound])');
        Array.prototype.forEach.call(nodes, function (el) {
            if (el.dataset && el.dataset.sgcBound) return;
            new SegmentedControl(el);
        });
    };

    /* ---------------- 自动初始化 ---------------- */

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', SegmentedControl.initAll);
    } else {
        SegmentedControl.initAll();
    }

    // 暴露到全局
    global.SegmentedControl = SegmentedControl;
})(window);