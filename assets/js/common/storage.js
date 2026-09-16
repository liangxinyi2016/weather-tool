/**
 * localStorage 封装
 * - 自动 JSON 编解码
 * - 错误兜底（quota exceeded、安全模式禁用等）
 */
(function (global) {
    'use strict';

    var PREFIX = 'met_tool:';
    var disabled = false;

    try {
        var probeKey = PREFIX + '__probe__';
        global.localStorage.setItem(probeKey, '1');
        global.localStorage.removeItem(probeKey);
    } catch (e) {
        disabled = true;
        // eslint-disable-next-line no-console
        console.warn('[Storage] localStorage 不可用，将降级为内存存储。', e);
    }

    // 内存降级方案
    var memoryStore = {};

    function rawGet(key) {
        if (disabled) return memoryStore.hasOwnProperty(key) ? memoryStore[key] : null;
        try { return global.localStorage.getItem(key); } catch (e) { return null; }
    }

    function rawSet(key, value) {
        if (disabled) { memoryStore[key] = value; return; }
        try { global.localStorage.setItem(key, value); } catch (e) {
            // 配额溢出：清空日志缓冲外的临时键，抛出提示
            if (global.Logger) global.Logger.warn('[Storage] 写入失败：' + (e && e.message));
        }
    }

    function rawRemove(key) {
        if (disabled) { delete memoryStore[key]; return; }
        try { global.localStorage.removeItem(key); } catch (e) { /* ignore */ }
    }

    var Storage = {
        /** 获取 JSON 形式的值，找不到或解析失败时返回 defaultValue */
        get: function (key, defaultValue) {
            var raw = rawGet(PREFIX + key);
            if (raw === null || raw === undefined) return defaultValue;
            try { return JSON.parse(raw); } catch (e) { return defaultValue; }
        },

        /** 写入 JSON 形式的值 */
        set: function (key, value) {
            try { rawSet(PREFIX + key, JSON.stringify(value)); }
            catch (e) { /* ignore */ }
        },

        /** 删除某个键 */
        remove: function (key) { rawRemove(PREFIX + key); },

        /** 写入原始字符串 */
        setString: function (key, value) { rawSet(PREFIX + key, value); },

        /** 读取原始字符串 */
        getString: function (key) { return rawGet(PREFIX + key); }
    };

    global.Storage = Storage;
})(window);
