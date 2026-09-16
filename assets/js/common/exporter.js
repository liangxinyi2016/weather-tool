/**
 * 通用文本导出器
 * - 触发浏览器下载（Blob + a[download]）
 * - 支持纯文本与 Markdown
 */
(function (global) {
    'use strict';

    /**
     * 触发浏览器下载文本
     * @param {string} text
     * @param {string} filename
     * @param {string} mime
     */
    function downloadText(text, filename, mime) {
        try {
            var blob = new Blob([text], { type: (mime || 'text/plain') + ';charset=utf-8' });
            var url = URL.createObjectURL(blob);
            var a = document.createElement('a');
            a.href = url;
            a.download = filename || 'download.txt';
            a.style.display = 'none';
            document.body.appendChild(a);
            a.click();
            setTimeout(function () {
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
            }, 100);
            return true;
        } catch (e) {
            if (global.Logger) global.Logger.error('下载失败', e);
            return false;
        }
    }

    /**
     * 复制文本到剪贴板（降级方案：临时 textarea + execCommand）
     * @param {string} text
     */
    function copyText(text) {
        return new Promise(function (resolve) {
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(text).then(function () { resolve(true); }, function () {
                    resolve(fallbackCopy(text));
                });
            } else {
                resolve(fallbackCopy(text));
            }
        });
    }

    function fallbackCopy(text) {
        try {
            var ta = document.createElement('textarea');
            ta.value = text;
            ta.style.position = 'fixed';
            ta.style.top = '-1000px';
            document.body.appendChild(ta);
            ta.select();
            var ok = false;
            try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
            document.body.removeChild(ta);
            return ok;
        } catch (e) { return false; }
    }

    /**
     * 生成文件名后缀时间戳
     */
    function stamp() {
        var d = new Date();
        var p = function (n) { return n < 10 ? '0' + n : '' + n; };
        return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '_' +
            p(d.getHours()) + p(d.getMinutes());
    }

    var Exporter = {
        downloadText: downloadText,
        copyText: copyText,
        stamp: stamp
    };

    global.Exporter = Exporter;
})(window);
