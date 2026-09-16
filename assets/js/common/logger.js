/**
 * 统一日志模块
 * - debug / info / warn / error 四个级别
 * - 同时输出到浏览器控制台与内存环形缓冲（最近 200 条）
 * - 提供"查看日志"和"下载日志"能力
 */
(function (global) {
    'use strict';

    /** 内存环形缓冲最大条数 */
    var MAX_LOGS = 200;

    /** 内存中的日志条目 */
    var buffer = [];

    /** 监听器集合（用于 UI 实时刷新） */
    var listeners = [];

    /**
     * 格式化日志条目
     * @param {string} level
     * @param {string} message
     * @param {Array} args
     */
    function formatArgs(args) {
        if (!args || args.length === 0) return '';
        try {
            return args.map(function (a) {
                if (a instanceof Error) return a.stack || (a.name + ': ' + a.message);
                if (typeof a === 'object') {
                    try { return JSON.stringify(a); } catch (e) { return String(a); }
                }
                return String(a);
            }).join(' ');
        } catch (e) {
            return String(args);
        }
    }

    /**
     * 通用写日志入口
     * @param {string} level
     * @param {string} message
     * @param {Array} args
     */
    function write(level, message, args) {
        var entry = {
            ts: new Date().toISOString(),
            level: level,
            message: message,
            detail: formatArgs(args)
        };
        // 控制台输出
        var fn = console[level] || console.log;
        var line = '[' + entry.ts + '] [' + level.toUpperCase() + '] ' + message;
        if (entry.detail) line += ' ' + entry.detail;
        try { fn.call(console, line); } catch (e) { /* ignore */ }

        // 推入缓冲
        buffer.push(entry);
        if (buffer.length > MAX_LOGS) buffer.shift();

        // 通知监听器
        for (var i = 0; i < listeners.length; i++) {
            try { listeners[i](entry); } catch (e) { /* ignore */ }
        }
    }

    var Logger = {
        debug: function (msg) { write('debug', msg, Array.prototype.slice.call(arguments, 1)); },
        info:  function (msg) { write('info',  msg, Array.prototype.slice.call(arguments, 1)); },
        warn:  function (msg) { write('warn',  msg, Array.prototype.slice.call(arguments, 1)); },
        error: function (msg) { write('error', msg, Array.prototype.slice.call(arguments, 1)); },

        /** 获取所有日志（副本） */
        getAll: function () { return buffer.slice(); },

        /** 清空内存日志 */
        clear: function () { buffer = []; notifyClear(); },

        /** 注册监听器（用于 UI 实时刷新） */
        onChange: function (fn) {
            if (typeof fn === 'function') listeners.push(fn);
        },

        /** 序列化为纯文本 */
        toText: function () {
            return buffer.map(function (e) {
                return '[' + e.ts + '] [' + e.level.toUpperCase() + '] ' + e.message +
                    (e.detail ? ' ' + e.detail : '');
            }).join('\n');
        },

        /** 当前缓冲条数 */
        size: function () { return buffer.length; }
    };

    function notifyClear() {
        for (var i = 0; i < listeners.length; i++) {
            try { listeners[i](null); } catch (e) { /* ignore */ }
        }
    }

    global.Logger = Logger;
})(window);
