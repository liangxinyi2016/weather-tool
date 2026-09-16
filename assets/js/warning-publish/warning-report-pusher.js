/**
 * 机场预警上报模块
 * --------------------------------------------------------------------
 * 职责：把用户在「确认发布序号」弹窗中确认的预警信息，推送到自建服务器，
 *       供其他软件读取（服务端落 app_documents 的 airport_warning 键）。
 *
 * 设计要点：
 *   1. 上报时机：由 warning-template.js 在用户点击「确认」后调用 pushWarning(data)
 *      取消弹窗不会上报（不产生无效数据）
 *   2. 尽力而为（best-effort）：任何失败（未配置 / 超时 / 网络不可达 / 服务端 4xx-5xx）
 *      都只写日志，绝不抛出、绝不阻塞截图与历史记录入库
 *   3. 配置来源：assets/js/common/server-config.local.js 暴露的 window.MeteoServerConfig
 *      该文件被 .gitignore 的 *.local.js 规则忽略，密钥不进入版本库
 *      若该文件缺失或密钥为空 → 跳过上报并记录一次提示日志
 *   4. 超时控制：AbortController，默认 8s，避免服务器不可达时长时间挂起
 *
 * 服务端接口约定：
 *   POST {baseUrl}/api/plugin/warning-report
 *   Header: Content-Type: application/json / X-API-Key: <apiKey>
 *   Body:   { airport, level, phenomenon, serialNo, publishTime, current, forecast, producer, phone, period }
 *   响应:   200 { message, total, received_at } / 400 { error } / 401 { error } / 503 { error }
 *
 *   其中 period（发生时段）为派生字段：复用导出预警记录（warning-record-exporter.js）
 *   的解析规则（parsePeriod），保证上报值与导出 Excel 的「发生时段」列完全一致；
 *   解析不出时上传空字符串，不影响其他字段。
 *
 * 暴露对象：window.WarningReportPusher
 *   - isConfigured(): boolean          是否已配置服务器地址与密钥
 *   - pushWarning(data): Promise<object> 上报（永不 reject）
 */
(function (global) {
    'use strict';

    /* ============================================================
     * 常量
     * ============================================================ */

    /** 上报接口路径（与 DSP INFO 服务端 plugin.routes.js 保持一致） */
    var REPORT_PATH = '/api/plugin/warning-report';

    /** 请求超时（毫秒）：服务器不可达时避免长时间挂起 */
    var REQUEST_TIMEOUT_MS = 8000;

    /**
     * 预警等级 → 中文全名映射
     * 表单内部使用单字（黄/橙/红），对外上报转为完整名称，便于其他软件直接展示
     */
    var LEVEL_FULL_NAME = { '黄': '黄色', '橙': '橙色', '红': '红色' };

    /**
     * 上报字段白名单（与服务端 warning-report.service.js 的 FIELD_LIMITS 一致）
     * 说明：period（发生时段）为派生字段，不在此列表中，由 buildPayload 单独解析写入
     */
    var PUSH_FIELDS = [
        'airport', 'level', 'phenomenon', 'serialNo',
        'publishTime', 'current', 'forecast', 'producer', 'phone'
    ];

    /** 配置缺失提示只记录一次，避免高频调用刷屏日志 */
    var configWarned = false;

    /** 安全调用 Logger，缺失时降级为 console */
    function logInfo(msg, detail) { try { Logger.info(msg, detail || ''); } catch (e) { console.log(msg, detail); } }
    function logWarn(msg, detail) { try { Logger.warn(msg, detail || ''); } catch (e) { console.warn(msg, detail); } }

    /**
     * 读取本地配置
     * @returns {{baseUrl: string, apiKey: string}} 归一化后的配置（缺失项为空字符串）
     */
    function readConfig() {
        var cfg = global.MeteoServerConfig || {};
        var baseUrl = String(cfg.baseUrl || '').trim();
        // 去掉末尾斜杠，避免与 REPORT_PATH 拼出双斜杠
        if (baseUrl.endsWith('/')) {
            baseUrl = baseUrl.slice(0, -1);
        }
        return {
            baseUrl: baseUrl,
            apiKey: String(cfg.apiKey || '').trim()
        };
    }

    /**
     * 是否已正确配置（地址与密钥均非空）
     * @returns {boolean}
     */
    function isConfigured() {
        var cfg = readConfig();
        return !!(cfg.baseUrl && cfg.apiKey);
    }

    /**
     * 解析「发生时段」（派生字段）
     * - 直接复用导出预警记录模块的解析规则，保证上传值与导出 Excel「发生时段」列一致：
     *     规则1 有显式时间段 → 首个开始 - 最后结束
     *     规则2 仅有「X 前」 → 发布时间 - X
     *     规则3 仅有「X 后」 → 发布时间 - X
     *     规则4 均无 → 空字符串
     * - 依赖某个模块未加载或解析异常时一律返回空字符串：上报是尽力而为，
     *   绝不能因为解析失败而中断上报
     * @param {object} data 预警表单数据（读取 forecast 与 publishTime）
     * @returns {string} 形如 "14:20-15:00"；解析不出返回 ''
     */
    function parseOccurPeriod(data) {
        var exporter = global.WarningRecordExporter;
        if (!exporter || typeof exporter.parsePeriod !== 'function') {
            logWarn('warning period parse skipped: WarningRecordExporter 未加载');
            return '';
        }
        try {
            // 发布时间（HH:MM）由导出模块的同名方法提取，规则2/3 需要它作为起始时间
            var publishHHMM = (typeof exporter.extractPublishHHMM === 'function')
                ? exporter.extractPublishHHMM(data.publishTime)
                : '';
            return exporter.parsePeriod(data.forecast || '', publishHHMM) || '';
        } catch (e) {
            logWarn('warning period parse failed: ' + (e && e.message));
            return '';
        }
    }

    /**
     * 由表单数据构造上报载荷
     * - 仅保留白名单字段，其余一律不上送
     * - 等级转为中文全名（黄 → 黄色）
     * - 附加上派生字段 period（发生时段，按导出模块规则解析）
     * @param {object} data 预警表单数据
     * @returns {object} 上报载荷
     */
    function buildPayload(data) {
        var payload = {};
        var source = data && typeof data === 'object' ? data : {};
        for (var i = 0; i < PUSH_FIELDS.length; i++) {
            var field = PUSH_FIELDS[i];
            var value = source[field] == null ? '' : String(source[field]).trim();
            if (field === 'level' && value) {
                value = LEVEL_FULL_NAME[value] || value;
            }
            payload[field] = value;
        }
        // 派生字段：发生时段（先解析，再随其他字段一同上传）
        payload.period = parseOccurPeriod(source);
        return payload;
    }

    /**
     * 上报机场预警信息（永不 reject，失败仅返回 { ok:false }）
     * @param {object} data 预警表单数据（含 airport/serialNo/publishTime 等）
     * @returns {Promise<{ok: boolean, skipped?: boolean, status?: number, total?: number, message?: string}>}
     */
    function pushWarning(data) {
        if (!isConfigured()) {
            if (!configWarned) {
                configWarned = true;
                logWarn('warning report push skipped: server-config.local.js 未配置 baseUrl / apiKey');
            }
            return Promise.resolve({ ok: false, skipped: true, message: '未配置服务器地址或密钥' });
        }

        var cfg = readConfig();
        var payload = buildPayload(data);
        var controller = typeof global.AbortController === 'function' ? new global.AbortController() : null;
        var timer = null;

        if (controller) {
            timer = setTimeout(function () {
                try { controller.abort(); } catch (e) { /* ignore */ }
            }, REQUEST_TIMEOUT_MS);
        }

        var options = {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-API-Key': cfg.apiKey
            },
            body: JSON.stringify(payload)
        };
        if (controller) {
            options.signal = controller.signal;
        }

        return global.fetch(cfg.baseUrl + REPORT_PATH, options).then(function (resp) {
            return resp.json().catch(function () { return {}; }).then(function (body) {
                if (!resp.ok) {
                    logWarn('warning report push rejected: HTTP ' + resp.status + ' ' + (body && body.error || ''));
                    return { ok: false, status: resp.status, message: (body && body.error) || ('HTTP ' + resp.status) };
                }
                logInfo('warning report pushed: ' + (payload.airport || '') +
                    ' serial=' + (payload.serialNo || '') + ' period=' + (payload.period || '(空)') +
                    ' total=' + (body && body.total));
                return { ok: true, status: resp.status, total: body && body.total, message: body && body.message };
            });
        }).catch(function (err) {
            // 网络异常 / 超时 / 被中断：仅记录，不向上抛出
            var reason = (err && err.name === 'AbortError') ? '请求超时' : (err && err.message);
            logWarn('warning report push failed: ' + reason);
            return { ok: false, message: reason || '网络异常' };
        }).then(function (result) {
            if (timer) clearTimeout(timer);
            return result;
        });
    }

    global.WarningReportPusher = {
        isConfigured: isConfigured,
        pushWarning: pushWarning
    };
})(window);