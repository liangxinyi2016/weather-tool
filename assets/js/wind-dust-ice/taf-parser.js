/**
 * TAF 报文解析器
 * --------------------------------------------------------------------
 * 设计目标
 *   1. 支持标准 TAF（ICAO）格式：TAF KXXX DDHHMM Z DDHH/DDHH ...
 *   2. 支持主组 + TEMPO / BECMG / PROB30 / PROB40 / FM 子组
 *   3. 多份 TAF 文本时，仅解析时间戳最新的一份（按发布日期 DDHHMM 比较）
 *   4. 暴露 identifyWindDustIce(parsed) 接口，按自定义阈值识别大风/沙尘/结冰
 *   5. 所有对外可见的时间字段（period 等）已统一由 UTC 转换为北京时间（UTC+8）
 *
 * 暴露对象：window.TafParser
 *   - parse(text): 解析入口，返回 { reports, selected, ignored }
 *   - identifyWindDustIce(parsed, rules): 识别大风/沙尘/结冰
 */
(function (global) {
    'use strict';

    /* ============================================================
     * 基础工具
     * ============================================================ */

    /**
     * 统一通过 ParsingRules 完成单位换算，KT -> MPS、MPS -> MPS。
     * 静风：00000MPS / 00000KT 视为 speedMs = 0。
     * VRB：direction 字段直接保留 'VRB'，下游需自行处理。
     */
    function convertSpeed(value, unit) {
        if (value === null || value === undefined) return null;
        return ParsingRules.toMs(value, unit);
    }

    /**
     * 拆词：按空白切分 TAF 报文
     * 同时将 `=` 前后补空格，使 `NOSIG=` / `CAVOK=` / `TN10/0122Z=` 这类结尾词
     * 与 `=` 分离，便于 parseTafBlock 等模块按独立 token 处理。
     * （行为与 translator.js 的 tokenize 保持一致）
     */
    function tokenize(text) {
        if (!text) return [];
        return String(text)
            .replace(/\r\n?/g, '\n')
            .replace(/=/g, ' = ')
            .split(/\s+/)
            .map(function (s) { return s.trim(); })
            .filter(Boolean);
    }

    /**
     * 切分多机场文本
     * - 支持形如 "〖ZLXY〗 ... 〖ZLLL〗 ..." 的中文方头括号标记（开始括号可选）
     * - 若文本中不包含方头括号，则整体作为一段返回（向后兼容单机场输入）
     * @param {string} text
     * @returns {Array<{icao: string, raw: string}>}
     */
    function splitByAirportMarker(text) {
        var raw = String(text || '').replace(/\r\n?/g, '\n').trim();
        if (!raw) return [];
        // 兼容 〖 〗 / 【 】 / 〔 〕 / [ ] 4 种标记；开始括号可选（如 "ZLXY〗"）
        var re = /[\[【〖〔]?\s*([A-Z]{4})\s*[\]】〗〕]/g;
        var markers = [];
        var m;
        while ((m = re.exec(raw)) !== null) {
            markers.push({ index: m.index, end: re.lastIndex, icao: m[1] });
        }
        if (markers.length === 0) return [];
        var groups = [];
        for (var i = 0; i < markers.length; i++) {
            var cur = markers[i];
            var nextStart = (i + 1 < markers.length) ? markers[i + 1].index : raw.length;
            var body = raw.substring(cur.end, nextStart).trim();
            groups.push({ icao: cur.icao, raw: body });
        }
        return groups;
    }

    /**
     * 从一段机场文本中提取 TAF 报文（跳过 METAR / SPECI）
     * - 兼容段尾的 "=" 结束符
     * - 同机场多份 TAF 取"按发布时间最新"的一份
     * @param {string} text
     * @returns {Array<{icao: string, text: string}>}
     */
    function extractTafsInBlock(text) {
        var raw = String(text || '');
        if (!raw) return [];
        // 用 splitMultipleTafs 提取所有 TAF 文本块（自动跳过 METAR/SPECI）
        var chunks = splitMultipleTafs(raw);
        var out = [];
        chunks.forEach(function (chunk) {
            // 去掉段尾 "=" 与多余空白
            var cleaned = chunk.replace(/=\s*$/, '').trim();
            if (!cleaned) return;
            // 必须以 TAF 开头（允许 TAF / TAF AMD / TAF COR），否则视为 METAR/SPECI 跳过
            if (!/^TAF(\s+(AMD|COR))?\s+[A-Z]{4}\s+\d{6}Z\s/i.test(cleaned)) return;
            // 从文本里取 ICAO
            var icaoMatch = cleaned.match(/\b([A-Z]{4})\s+\d{6}Z\b/);
            var icao = icaoMatch ? icaoMatch[1] : '';
            out.push({ icao: icao, text: cleaned });
        });
        return out;
    }

    /**
     * 在文本中按分隔符切出多份 TAF
     * - 优先按"TAF "开头切分
     * - 兼容直接粘贴多份（无 TAF 前缀）：当且仅当文本中包含 AMD/COR 等修正标识且在
     *   内部已切分时，按 NL/换行分组再合并
     */
    function splitMultipleTafs(text) {
        var raw = String(text || '').replace(/\r\n?/g, '\n').trim();
        if (!raw) return [];
        // 多个 TAF 标识：TAF/TAF AMD/TAF COR 出现多次
        var re = /(?:^|\n)\s*TAF(?:\s+(?:AMD|COR))?\s+/gi;
        var chunks = [];
        var match;
        var lastIndex = 0;
        while ((match = re.exec(raw)) !== null) {
            var start = match.index + (match[0].startsWith('\n') ? 1 : 0);
            if (start > lastIndex) {
                var prev = raw.substring(lastIndex, start).trim();
                if (prev) chunks.push(prev);
            }
            lastIndex = start;
        }
        if (lastIndex < raw.length) {
            var tail = raw.substring(lastIndex).trim();
            if (tail) chunks.push(tail);
        }
        if (chunks.length === 0) chunks.push(raw);
        return chunks;
    }

    /**
     * 解析 TAF 头部
     * 例：TAF ZPPP 120300Z 1206/1312
     * 格式：TAF [AMD|COR] ICAO DDHHMM(Z) DDHH/DDHH
     */
    function parseHeader(tokens) {
        var idx = 0;
        var isAmd = false;
        var isCor = false;
        if (tokens[idx] === 'TAF') idx++;
        if (tokens[idx] === 'AMD') { isAmd = true; idx++; }
        if (tokens[idx] === 'COR') { isCor = true; idx++; }
        var icao = tokens[idx++];
        var issueRaw = tokens[idx++]; // 120300Z
        if (!icao || !/^[A-Z]{4}$/.test(icao)) {
            throw new Error('TAF 头部解析失败：未找到 4 字母 ICAO（位置 ' + (idx - 1) + '）');
        }
        if (!issueRaw || !/^\d{6}Z$/.test(issueRaw)) {
            throw new Error('TAF 头部解析失败：发布时间应为 DDHHMMZ（位置 ' + (idx - 1) + '）');
        }
        var periodRaw = tokens[idx++]; // 1206/1312
        if (!periodRaw || !/^\d{4}\/\d{4}$/.test(periodRaw)) {
            throw new Error('TAF 头部解析失败：有效时间段应为 DDHH/DDHH（位置 ' + (idx - 1) + '）');
        }
        var issueDay = parseInt(issueRaw.substring(0, 2), 10);
        var issueHour = parseInt(issueRaw.substring(2, 4), 10);
        var issueMin = parseInt(issueRaw.substring(4, 6), 10);
        var startDay = parseInt(periodRaw.substring(0, 2), 10);
        var startHour = parseInt(periodRaw.substring(2, 4), 10);
        var endDay = parseInt(periodRaw.substring(5, 7), 10);
        var endHour = parseInt(periodRaw.substring(7, 9), 10);
        return {
            icao: icao,
            isAmd: isAmd,
            isCor: isCor,
            issue: { day: issueDay, hour: issueHour, min: issueMin, raw: issueRaw },
            validPeriod: {
                startDay: startDay, startHour: startHour,
                endDay: endDay, endHour: endHour, raw: periodRaw
            },
            consumedTokens: idx
        };
    }

    /**
     * 将 TAF 时段内的 day/hour 解析为可比较的分钟数（相对开始日 0 点）
     * 由于 TAF 仅给"日/小时"，且可能跨月，这里使用与开始日相对偏移
     */
    function toAbsOffset(startDay, day, hour) {
        var dayDelta = day - startDay;
        if (dayDelta < 0) dayDelta += 30; // 跨月防御
        return dayDelta * 24 * 60 + hour * 60;
    }

    /**
     * 解析风向风速
     * 例：25015KT / 25015G25KT / VRB03KT / 00000KT
     * 例：25015MPS / 25015G25MPS / VRB03MPS / 00000MPS
     *
     * 返回结构：
     *   { direction, speedRaw, speedMs, gustRaw?, gustMs?, unit, variable, calm }
     *   - variable: 是否多变风（direction === 'VRB'）
     *   - calm: 是否静风（direction === '000' && speedRaw === 0）
     */
    function parseWind(token) {
        if (!token) return null;
        // KT 与 MPS 两种单位均支持；3 位方向（数字或 VRB）+ 2~3 位风速 + 可选 G 阵风
        var m = token.match(/^(\d{3}|VRB)(\d{2,3})(G(\d{2,3}))?(KT|MPS)$/);
        if (!m) return null;
        var direction = m[1];
        var speedRaw = parseInt(m[2], 10);
        var gustRaw = m[4] ? parseInt(m[4], 10) : null;
        var unit = m[5];
        var speedMs = convertSpeed(speedRaw, unit);
        var gustMs = gustRaw !== null ? convertSpeed(gustRaw, unit) : null;
        return {
            direction: direction,
            speedRaw: speedRaw,
            speedMs: speedMs,
            gustRaw: gustRaw,
            gustMs: gustMs,
            unit: unit,
            variable: direction === 'VRB',
            calm: direction === '000' && speedRaw === 0
        };
    }

    /**
     * 解析能见度
     * 例：3000 / 9999 / 6000 / 9999
     * 简化处理：纯数字 4 位表示米
     */
    function parseVisibility(token) {
        if (/^\d{4}$/.test(token)) {
            return { raw: token, meters: parseInt(token, 10) };
        }
        // 暂不处理 SM（英里）格式
        return null;
    }

    /**
     * 解析天气现象
     * 例：+TSRA / -RA / SA / SS / DS / BR
     */
    function parseWeather(token) {
        // 强度前缀：- / + / 留空
        // 描述符：TS/FZ/SH/BC/PL/DR/BL/FG/FU/VA
        // 降水：RA/DZ/SN/SG/PL/GR/GS/UP
        // 遮蔽：BR/FG/FU/VA/DU/SA/SS/PY
        // 其它：SQ/FC/SS/DS
        // 过去天气前缀：RE（观测前出现的天气现象）
        if (!/^([+\-]?)([A-Z]{2,6})$/.test(token)) return null;
        var upper = token.toUpperCase();
        var intensity = '';
        if (upper[0] === '+' || upper[0] === '-') {
            intensity = upper[0];
            upper = upper.substring(1);
        }
        // 过去天气前缀 RE（如 RETSRA = 观测前出现雷雨）
        var isRecent = false;
        if (upper.length >= 4 && upper.substring(0, 2) === 'RE') {
            isRecent = true;
            upper = upper.substring(2);
        }
        // 必须是天气现象（2-6 字符，包含已知关键词）
        // 排除趋势关键字避免误识别（TEMPO 含 PO，NOSIG 含 SI/IG 等）
        var known = ['TS', 'RA', 'DZ', 'SN', 'SG', 'PL', 'GR', 'GS', 'UP',
            'BR', 'FG', 'FU', 'VA', 'DU', 'SA', 'SS', 'PY',
            'FZ', 'SH', 'BC', 'DR', 'BL', 'SQ', 'FC', 'DS', 'MI', 'BC',
            'HZ', 'PO'];
        var excluded = ['TEMPO', 'BECMG', 'NOSIG', 'NSW'];
        for (var e = 0; e < excluded.length; e++) {
            if (upper === excluded[e]) return null;
        }
        // 严格匹配：必须以 2 字符为单位整段匹配（开头/中间/末尾），而不是任意子串包含
        var matched = false;
        for (var i = 0; i < known.length; i++) {
            // 检查 known[i] 是否作为 2 字符片段出现在 upper 中（按 2 字符切片）
            if (upper === known[i]) { matched = true; break; }
            if (upper.length >= 2) {
                for (var p = 0; p <= upper.length - 2; p += 2) {
                    if (upper.substring(p, p + 2) === known[i]) { matched = true; break; }
                }
            }
            if (matched) break;
        }
        if (!matched) return null;
        return { raw: token, intensity: intensity, codes: collectPhenCodes(upper), isRecent: isRecent };
    }

    /**
     * 提取现象中的关键代码（SA/SS/DS/BR/FG/HZ 等）
     */
    function collectPhenCodes(token) {
        // 拆成 2 字符一组（描述符 2 字符 + 现象 2/3 字符 + 遮蔽 2 字符）
        var codes = [];
        // 描述符（2 字符）
        var descs = ['TS', 'FZ', 'SH', 'BC', 'DR', 'BL', 'MI'];
        for (var i = 0; i < descs.length; i++) {
            if (token.indexOf(descs[i]) === 0) { codes.push(descs[i]); break; }
        }
        // 主体（多个 2 字符片段）
        var re = /[A-Z]{2}/g;
        var m;
        while ((m = re.exec(token)) !== null) codes.push(m[0]);
        return Array.from(new Set(codes));
    }

    /**
     * 解析云组
     * 例：FEW020 / SCT040 / BKN100 / OVC250 / VV/// / NSC / SKC / NCD / CLR
     *
     * 返回结构：
     *   { raw, type, height, cb?, semantic? }
     *   - NSC 携带 semantic:'no-cloud-below-threshold'，与 SKC/NCD/CLR 的
     *     semantic:'sky-clear' 区分；下游 translator 据此给出不同中文文案
     *   - FEW/SCT/BKN/OVC/VV 不带 semantic 字段（保持向后兼容）
     */
    function parseCloud(token) {
        if (token === 'NSC') {
            return { raw: token, type: token, height: null, semantic: 'no-cloud-below-threshold' };
        }
        if (token === 'SKC' || token === 'NCD' || token === 'CLR') {
            return { raw: token, type: token, height: null, semantic: 'sky-clear' };
        }
        if (/^VV\/{3}$/.test(token)) {
            return { raw: token, type: 'VV', height: null };
        }
        var m = token.match(/^(FEW|SCT|BKN|OVC)(\d{3})(CB|TCU)?$/);
        if (m) {
            return { raw: token, type: m[1], height: parseInt(m[2], 10) * 100, cb: m[3] || null };
        }
        return null;
    }

    /**
     * 解析温度组
     * 支持的格式：
     *   - T17/05 或 T17/M05  ：同时给出 Tmax/Tmin
     *   - TX20/1207Z         ：Tmax 20，发生在 day12 hour07Z
     *   - TN05/1212Z         ：Tmin 5，发生在 day12 hour12Z
     *   - Tmax17 / TminM05   ：单独给出（少见）
     */
    function parseTemperatureGroup(token) {
        // 单一 TN/MN：T17/05 / T17/M05
        var m = token.match(/^T(M?)(\d{2})\/(M?)(\d{2})$/);
        if (m) {
            var tmax = (m[1] === 'M' ? -1 : 1) * parseInt(m[2], 10);
            var tmin = (m[3] === 'M' ? -1 : 1) * parseInt(m[4], 10);
            return { type: 'pair', tmax: tmax, tmin: tmin, raw: token };
        }
        // TXnn/DDHHZ 或 TNnn/DDHHZ
        var m2 = token.match(/^T(X|N)(M?)(\d{2})\/(\d{2})(\d{2})Z$/);
        if (m2) {
            var val = (m2[2] === 'M' ? -1 : 1) * parseInt(m2[3], 10);
            return {
                type: m2[1] === 'X' ? 'max' : 'min',
                value: val,
                day: parseInt(m2[4], 10),
                hour: parseInt(m2[5], 10),
                raw: token
            };
        }
        // 单一 MAX/MIN：Tmax17 / Tmin05 / TmaxM05
        var m3 = token.match(/^T(MAX|MIN)(M?)(\d{2})$/);
        if (m3) {
            var val2 = (m3[2] === 'M' ? -1 : 1) * parseInt(m3[3], 10);
            return { type: m3[1].toLowerCase(), value: val2, raw: token };
        }
        return null;
    }

    /**
     * 解析变化组起始子句
   * 例：BECMG 1208/1211 / TEMPO 1212/1218 / PROB30 1212/1214 / FM121200
     * 返回 { type, period: {startDay,startHour,endDay?,endHour?}, consumedTokens }
     */
    function parseChangeGroup(tokens, idx, validPeriod, startDay) {
        if (idx >= tokens.length) return null;
        var t = tokens[idx];
        // FM 是单点，后续 day/hour
        if (/^FM(\d{2})(\d{2})$/.test(t)) {
            var m = t.match(/^FM(\d{2})(\d{2})$/);
            return {
                type: 'FM', period: { startDay: +m[1], startHour: +m[2] },
                consumedTokens: 1
            };
        }
        if (t === 'BECMG' || t === 'TEMPO' || t === 'PROB30' || t === 'PROB40') {
            var period = tokens[idx + 1];
            if (!/^\d{4}\/\d{4}$/.test(period)) {
                throw new Error('变化组时间段格式错误：' + period);
            }
            return {
                type: t,
                period: {
                    startDay: parseInt(period.substring(0, 2), 10),
                    startHour: parseInt(period.substring(2, 4), 10),
                    endDay: parseInt(period.substring(5, 7), 10),
                    endHour: parseInt(period.substring(7, 9), 10)
                },
                consumedTokens: 2
            };
        }
        return null;
    }

    /**
     * 解析子组（变化组内/主组）的要素
     * 包含：风/能见度/天气/云
     */
    function parseSubgroup(tokens, idx, maxIdx) {
        var wind = null, visibility = null, weather = [], clouds = [];
        while (idx < maxIdx) {
            var tk = tokens[idx];
            if (tk === 'CAVOK') {
                // CAVOK（ICAO Doc 4444 §4.3.6）：能见度按 CAVOK_VISIBILITY（10 000 m），
                // 并打 cavok=true 标记，沙尘识别会跳过 CAVOK 时段。
                // CAVOK 整体替代「能见度 + 天气现象 + 云」三组，
                // 因此同子组内 CAVOK 之后不应再解析任何 weather/cloud token。
                // 关键：必须用 break 而非 continue，
                // 否则后续 FEW/SCT/BKN/OVC 会被错误地识别为云组。
                // 温度组（T..）由 parseTafBlock 中独立 while 循环处理，不受本 break 影响。
                visibility = {
                    raw: 'CAVOK',
                    meters: ParsingRules.CAVOK_VISIBILITY,
                    cavok: true
                };
                idx++;
                break;
            }
            // 变化组开始符（不应在子组中遇到，但防御处理）
            if (/^(BECMG|TEMPO|PROB30|PROB40|FM\d{4})$/.test(tk)) break;
            if (/^T(MAX|MIN|M?\d{2}|M?\d{2}\/M?\d{2}|X\d{2}\/\d{4}Z|N\d{2}\/\d{4}Z)$/.test(tk)) break;
            var w = parseWind(tk);
            if (w) { wind = w; idx++; continue; }
            var v = parseVisibility(tk);
            if (v) { visibility = v; idx++; continue; }
            var ph = parseWeather(tk);
            if (ph) { weather.push(ph); idx++; continue; }
            var c = parseCloud(tk);
            if (c) { clouds.push(c); idx++; continue; }
            // NSW：无显著天气，标记能见度降级
            if (tk === 'NSW') { idx++; continue; }
            // 无法识别的 token，停止该子组解析以避免错位
            break;
        }
        return { wind: wind, visibility: visibility, weather: weather, clouds: clouds, nextIdx: idx };
    }

    /**
     * 解析一份 TAF 文本块
     * @param {string} text
     * @returns {object} parsed TAF
     */
    function parseTafBlock(text) {
        var tokens = tokenize(text);
        if (tokens.length === 0) throw new Error('TAF 内容为空');
        var header = parseHeader(tokens);
        var i = header.consumedTokens;

        // 主组覆盖整段有效时间
        var mainSub = parseSubgroup(tokens, i, tokens.length);
        i = mainSub.nextIdx;

        // 收集温度组
        var tmax = null, tmin = null;
        // 主组内的 T.. 已经收集完时再扫剩余 token 拿温度
        while (i < tokens.length) {
            var t = tokens[i];
            if (/^(BECMG|TEMPO|PROB30|PROB40|FM\d{4})$/.test(t)) break;
            var tmp = parseTemperatureGroup(t);
            if (tmp) {
                if (tmp.type === 'pair') {
                    tmax = tmp.tmax; tmin = tmp.tmin;
                } else if (tmp.type === 'max') {
                    tmax = tmp.value;
                } else if (tmp.type === 'min') {
                    tmin = tmp.value;
                }
                i++;
                continue;
            }
            // 未识别 token，停止（避免错位）
            break;
        }

        var changes = [];
        while (i < tokens.length) {
            // 跳过空白
            if (tokens[i] === '=') { i++; continue; }
            try {
                var ch = parseChangeGroup(tokens, i);
                if (!ch) break;
                i += ch.consumedTokens;
                var sg = parseSubgroup(tokens, i, tokens.length);
                i = sg.nextIdx;
                changes.push({
                    type: ch.type,
                    period: ch.period,
                    wind: sg.wind,
                    visibility: sg.visibility,
                    weather: sg.weather,
                    clouds: sg.clouds
                });
            } catch (e) {
                throw new Error('TAF 变化组解析失败：' + e.message);
            }
        }

        return {
            icao: header.icao,
            isAmd: header.isAmd,
            isCor: header.isCor,
            issue: header.issue,
            validPeriod: header.validPeriod,
            main: {
                wind: mainSub.wind,
                visibility: mainSub.visibility,
                weather: mainSub.weather,
                clouds: mainSub.clouds
            },
            tmax: tmax,
            tmin: tmin,
            changes: changes
        };
    }

    /**
     * 比较两份 TAF 的发布时间，返回正数表示 a 更新，负数表示 b 更新。
     * 通过 ParsingRules.tafIssueToTimestamp 转为绝对时间戳比较，
     * 自动覆盖"issue.day 看起来比 refDay 小很多（视为下月）"等跨月场景。
     */
    function compareIssue(a, b) {
        var tsA = ParsingRules.tafIssueToTimestamp(a);
        var tsB = ParsingRules.tafIssueToTimestamp(b);
        return tsA - tsB;
    }

    /* ============================================================
     * 大风/沙尘/结冰识别
     * ============================================================ */

    /**
     * 默认识别阈值
     * --------------------------------------------------------------------
     * 沙尘类代码白名单：SA 扬沙 / SS 沙暴 / DS 尘暴 / DU 浮尘
     *   - 触发条件：能见度 ≤ visThreshold (2000 m) 且出现下列任一代码
     *   - 强度前缀（+ / -，如 +SA / -SS）由 parseWeather 在解析阶段剥离，
     *     下游识别逻辑不感知前缀
     *   - 同一份 TAF 含多个沙尘代码时，按本数组顺序拼接中文标签
     *     （例：['SA','DU'] → 扬沙,浮尘；与代码在 TAF 中出现顺序无关）
     * 与 ParsingRules.DEFAULT_RULES 保持一致，便于跨模块共享
     */
    var DEFAULT_RULES = {
        windThreshold: 8,     // m/s
        gustThreshold: 8,     // m/s
        visThreshold: 2000,   // m
        tempThreshold: 10,    // ℃
        dustCodes: ['SA', 'SS', 'DS', 'DU']
    };

    function mergeRules(rules) {
        var r = {};
        for (var k in DEFAULT_RULES) {
            if (Object.prototype.hasOwnProperty.call(DEFAULT_RULES, k)) {
                r[k] = (rules && rules[k] !== undefined && rules[k] !== null) ? rules[k] : DEFAULT_RULES[k];
            }
        }
        if (rules && typeof rules.dustCodes === 'string') {
            r.dustCodes = rules.dustCodes.split(/[,，\s]+/).map(function (s) { return s.trim().toUpperCase(); })
                .filter(Boolean);
        }
        return r;
    }

    /**
     * 在一组时段内（含主组和变化组）识别大风
     * 大风：平均风 ≥ 阈值 或 阵风 ≥ 阈值
     * 静风/VRB 不会被识别为大风（speedMs = 0）
     */
    function identifyWind(parsed, rules) {
        var r = mergeRules(rules);
        var out = [];
        var validStart = parsed.validPeriod.startDay;
        function pushHit(label, period, wind) {
            var main = '阵风 ' + (wind.gustMs || '-') + ' m/s';
            if (!wind.gustMs) {
                main = '平均风 ' + wind.speedMs + ' m/s';
            } else if (wind.speedMs >= r.windThreshold) {
                main = '平均风 ' + wind.speedMs + ' m/s / 阵风 ' + wind.gustMs + ' m/s';
            }
            out.push({
                period: period,
                wind: wind,
                summary: main,
                direction: wind.direction,
                variable: wind.variable,
                unit: wind.unit
            });
        }
        var main = parsed.main;
        if (main.wind) {
            if (main.wind.speedMs >= r.windThreshold || (main.wind.gustMs !== null && main.wind.gustMs >= r.gustThreshold)) {
                pushHit('main', formatPeriod(parsed.validPeriod, validStart), main.wind);
            }
        }
        parsed.changes.forEach(function (ch) {
            if (ch.wind) {
                if (ch.wind.speedMs >= r.windThreshold || (ch.wind.gustMs !== null && ch.wind.gustMs >= r.gustThreshold)) {
                    pushHit(ch.type, formatPeriod(ch.period, validStart), ch.wind);
                }
            }
        });
        return out;
    }

    /**
     * 沙尘识别：能见度 ≤ 阈值 且 现象含指定代码
     * --------------------------------------------------------------------
     * 设计说明（CAVOK / NSC 与沙尘识别的关系）：
     *   - CAVOK：已被 ParsingRules.isCavok() 排除。
     *     CAVOK 隐含能见度 10 km（= CAVOK_VISIBILITY），必不命中 ≤ 阈值，
     *     所以无需再检查 weather/cloud，沙尘识别在 CAVOK 时段自然不命中。
     *   - NSC：不被特殊处理。NSC 仅替代云组，沙尘识别依赖天气现象（SA/SS/DS）。
     *     若 NSC 时段同时没有 weather 现象（如 "6000 NSC"），match() 自然返回空，
     *     命中被跳过；若 NSC 时段仍带 weather（罕见组合 "6000 NSC SA"），
     *     仍按现象识别沙尘——这与 ICAO 标准中 NSC 仅替代云组、SA/SS/DS 独立报告
     *     的语义一致。
     * CAVOK 时段（能见度 = CAVOK_VISIBILITY 且 cavok=true）直接跳过
     */
    function identifyDust(parsed, rules) {
        var r = mergeRules(rules);
        var out = [];
        var validStart = parsed.validPeriod.startDay;
        function match(weather) {
            if (!weather || weather.length === 0) return null;
            var matchedCodes = [];
            for (var i = 0; i < weather.length; i++) {
                var codes = weather[i].codes || [];
                for (var j = 0; j < codes.length; j++) {
                    if (r.dustCodes.indexOf(codes[j]) >= 0) matchedCodes.push(codes[j]);
                }
            }
            return Array.from(new Set(matchedCodes));
        }
        var main = parsed.main;
        // CAVOK 时段：跳过沙尘识别
        if (main.visibility && !ParsingRules.isCavok(main.visibility) && main.visibility.meters <= r.visThreshold) {
            var codes = match(main.weather);
            if (codes && codes.length > 0) {
                out.push({
                    period: formatPeriod(parsed.validPeriod, validStart),
                    minVisibility: main.visibility.meters,
                    codes: codes,
                    summary: '能见度 ' + main.visibility.meters + ' m，含 ' + codes.join('/')
                });
            }
        }
        parsed.changes.forEach(function (ch) {
            // CAVOK 时段：跳过沙尘识别
            if (ch.visibility && !ParsingRules.isCavok(ch.visibility) && ch.visibility.meters <= r.visThreshold) {
                var codes2 = match(ch.weather);
                if (codes2 && codes2.length > 0) {
                    out.push({
                        period: formatPeriod(ch.period, validStart),
                        minVisibility: ch.visibility.meters,
                        codes: codes2,
                        summary: '能见度 ' + ch.visibility.meters + ' m，含 ' + codes2.join('/')
                    });
                }
            }
        });
        return out;
    }

    /**
     * 结冰识别：Tmin < 温度阈值，时间段为 TAF 整体有效期
     */
    function identifyIce(parsed, rules) {
        var r = mergeRules(rules);
        var out = [];
        if (parsed.tmin === null || parsed.tmin === undefined) return out;
        if (parsed.tmin < r.tempThreshold) {
            out.push({
                period: formatPeriod(parsed.validPeriod, parsed.validPeriod.startDay),
                tmin: parsed.tmin,
                summary: 'Tmin=' + parsed.tmin + ' ℃，低于阈值 ' + r.tempThreshold + ' ℃'
            });
        }
        return out;
    }

    /**
     * 将 TAF 中的 day/hour 组装成"D+X HH:00"形式（用相对偏移，不依赖具体年月）
     * --------------------------------------------------------------------
     * 气象报文中的时间均为 UTC（世界协调时），本工具统一转换为北京时间（UTC+8）输出，
     * 供 UI 列表、Excel 通报等终端展示使用。
     *
     * 转换规则：
     *   1. 原始日 d + 8 小时
     *   2. 若小时溢出（≥ 24），向前跨 1 天：日 d+1、小时 h-24
     *   3. D+ 偏移基于 TAF 有效时段起点（startDay）的相对天数；
     *      跨日后偏移量自动 +1
     *
     * 示例（TAF 有效时段 18日06:00 起）：
     *   UTC 18日06:00 → 北京 18日14:00 → D+0 14:00
     *   UTC 18日20:00 → 北京 19日04:00 → D+1 04:00
     *   UTC 18日23:00 → 北京 19日07:00 → D+1 07:00
     *   UTC 19日06:00 → 北京 19日14:00 → D+1 14:00
     */
    function formatPeriod(period, startDay) {
        function fmt(d, h) {
            // UTC → 北京时（+8h）
            var bjHour = h + 8;
            var hourDelta = Math.floor(bjHour / 24);
            var finalHour = bjHour - hourDelta * 24;
            // D+ 偏移：相对 TAF 有效时段起点的天数
            var delta = (d + hourDelta) - startDay;
            if (delta < 0) delta += 30; // 跨月防御
            return 'D+' + delta + ' ' + (finalHour < 10 ? '0' + finalHour : '' + finalHour) + ':00';
        }
        if (period.startDay === undefined) return '?';
        var s = fmt(period.startDay, period.startHour);
        if (period.endDay === undefined) return s;
        var e = fmt(period.endDay, period.endHour);
        return s + ' ~ ' + e;
    }

    /**
     * 顶层解析入口
     * - 单机场输入（无 〖XXX〗 标记）走老逻辑：所有 TAF 取最新一份
     * - 多机场输入（带 〖XXX〗 标记）按机场分组；每组内仅保留 TAF（跳过 METAR/SPECI），
     *   同一机场多份 TAF 取"按发布时间最新"的一份
     * @param {string} text
     */
    function parse(text) {
        var errs = [];
        var groups = splitByAirportMarker(text);
        var isMultiAirport = groups.length > 0;

        /**
         * 收集一组 TAF 文本（chunk）并解析为 reports；同时附加机场标记 icaoHint
         */
        function collectReports(chunks, icaoHint) {
            var rep = [];
            chunks.forEach(function (chunk) {
                try {
                    var parsed = parseTafBlock(chunk);
                    if (icaoHint) parsed.markerIcao = icaoHint;
                    rep.push(parsed);
                } catch (e) {
                    errs.push({ index: errs.length, error: e.message, block: chunk, markerIcao: icaoHint || '' });
                }
            });
            return rep;
        }

        var allReports = [];
        if (isMultiAirport) {
            // 多机场：每个机场单独解析
            groups.forEach(function (g) {
                var tafs = extractTafsInBlock(g.raw);
                if (tafs.length === 0) {
                    errs.push({ index: errs.length, error: '机场 ' + g.icao + ' 未找到 TAF 报文', block: g.raw, markerIcao: g.icao });
                    return;
                }
                tafs.forEach(function (t) {
                    try {
                        var parsed = parseTafBlock(t.text);
                        parsed.markerIcao = g.icao;
                        allReports.push(parsed);
                    } catch (e) {
                        errs.push({ index: errs.length, error: e.message, block: t.text, markerIcao: g.icao });
                    }
                });
            });
            if (allReports.length === 0) {
                throw new Error('TAF 解析失败：' + (errs[0] ? errs[0].error : '未知错误'));
            }
            // 按机场分组：每组取"按发布时间最新"的一份
            var byAirport = {};
            allReports.forEach(function (r) {
                var icao = r.icao;
                if (!byAirport[icao]) byAirport[icao] = r;
                else if (compareIssue(r, byAirport[icao]) > 0) byAirport[icao] = r;
            });
            var selectedByIcao = byAirport;
            // 兼容老字段：selected 指向总体发布时间最新的一份
            var best = allReports[0], bestIdx = 0;
            for (var k = 1; k < allReports.length; k++) {
                if (compareIssue(allReports[k], best) > 0) {
                    best = allReports[k]; bestIdx = k;
                }
            }
            return {
                reports: allReports,
                byAirport: byAirport,
                selectedByIcao: selectedByIcao,
                selected: best,
                selectedIndex: bestIdx,
                ignored: allReports.length - Object.keys(byAirport).length,
                errors: errs,
                isMultiAirport: true,
                airports: Object.keys(byAirport)
            };
        }

        // 单机场输入（无 〖XXX〗 标记）时，仍按 ICAO 分组：每组取"按发布时间最新"的一份
        // 这样用户一次性粘贴多条 TAF（不加分隔标记）时，所有机场都能被正确解析
        var blocks = splitMultipleTafs(text);
        if (blocks.length === 0) throw new Error('未识别到任何 TAF 文本');
        for (var i = 0; i < blocks.length; i++) {
            try { allReports.push(parseTafBlock(blocks[i])); }
            catch (e) { errs.push({ index: i, error: e.message, block: blocks[i] }); }
        }
        if (allReports.length === 0) {
            throw new Error('TAF 解析失败：' + (errs[0] ? errs[0].error : '未知错误'));
        }
        // 按机场分组：每组取"按发布时间最新"的一份
        var byAirport = {};
        allReports.forEach(function (r) {
            var icao = r.icao;
            if (!byAirport[icao]) byAirport[icao] = r;
            else if (compareIssue(r, byAirport[icao]) > 0) byAirport[icao] = r;
        });
        var selectedByIcao = byAirport;
        // 兼容老字段：selected 指向总体发布时间最新的一份
        var best = allReports[0], bestIdx = 0;
        for (var k = 1; k < allReports.length; k++) {
            if (compareIssue(allReports[k], best) > 0) {
                best = allReports[k]; bestIdx = k;
            }
        }
        var icaoCount = Object.keys(byAirport).length;
        return {
            reports: allReports,
            byAirport: byAirport,
            selectedByIcao: selectedByIcao,
            selected: best,
            selectedIndex: bestIdx,
            // 忽略的份数 = 解析成功但被同机场更新版本覆盖的 TAF 数量
            ignored: allReports.length - icaoCount,
            errors: errs,
            // 多于 1 个机场时按多机场流程处理；仅 1 个时仍走单机场兼容分支
            isMultiAirport: icaoCount > 1,
            airports: Object.keys(byAirport)
        };
    }

    /**
     * 收集 TAF 中所有时段（主组 + 变化组）出现的天气现象代码
     * - 来源：parsed.main.weather 与 parsed.changes[*].weather
     * - 保留原始 raw（含强度前缀 +/-, 如 "+TSRA"）
     * - 去重：相同 raw 仅保留一个（保持首次出现顺序）
     * - 大小写归一：转大写比较，避免 "+tsra" / "TSRA" 被当作两条
     * @param {object} parsed
     * @returns {string[]} 例如 ['SA', 'SHRA']
     */
    function collectWeatherCodes(parsed) {
        if (!parsed) return [];
        var seen = {};
        var order = [];
        function add(weather) {
            if (!weather || weather.length === 0) return;
            weather.forEach(function (w) {
                if (!w || !w.raw) return;
                var key = String(w.raw).toUpperCase();
                if (seen[key]) return;
                seen[key] = true;
                order.push(w.raw);
            });
        }
        if (parsed.main) add(parsed.main.weather);
        if (Array.isArray(parsed.changes)) {
            parsed.changes.forEach(function (ch) { add(ch.weather); });
        }
        return order;
    }

    /**
     * 三要素识别入口
     * - 单份 TAF：返回 { wind, dust, ice, phenomena }
     * - 多份 TAF（按机场聚合）：返回 { byIcao: { icao -> { wind, dust, ice, phenomena } } }
     * - phenomena：TAF 内出现的全部天气现象代码（按出现顺序去重，原始大小写），含 SA/SS/DS/DU
     * - dust：识别的沙尘事件数组（每项含 codes 字段，列出命中的沙尘类代码；事件已隐含"能见度≤2000"前提）
     *   Excel "天气现象"列将根据 dust[0].codes 按 SA→扬沙 / SS→沙暴 / DS→尘暴 / DU→浮尘 分别映射
     *   （强度前缀 + / - 在解析阶段已剥离，识别不受影响）
     */
    function identifyWindDustIce(parsed, rules) {
        if (parsed && parsed.isMultiAirport && parsed.selectedByIcao) {
            var out = { byIcao: {} };
            Object.keys(parsed.selectedByIcao).forEach(function (icao) {
                out.byIcao[icao] = {
                    wind: identifyWind(parsed.selectedByIcao[icao], rules),
                    dust: identifyDust(parsed.selectedByIcao[icao], rules),
                    ice: identifyIce(parsed.selectedByIcao[icao], rules),
                    phenomena: collectWeatherCodes(parsed.selectedByIcao[icao])
                };
            });
            return out;
        }
        // 单机场：兼容两种调用方式
        //   1. 直接传 TAF 解析结果（含 icao/validPeriod/main/changes）
        //   2. 传 parse() 的包装结果（含 selected/isMultiAirport/ignored）
        // 统一 unwrap 到真正的 TAF 对象，避免外部传错导致 validPeriod 为 undefined
        var taf = (parsed && parsed.selected) ? parsed.selected : parsed;
        return {
            wind: identifyWind(taf, rules),
            dust: identifyDust(taf, rules),
            ice: identifyIce(taf, rules),
            phenomena: collectWeatherCodes(taf)
        };
    }

    var TafParser = {
        parse: parse,
        identifyWindDustIce: identifyWindDustIce,
        collectWeatherCodes: collectWeatherCodes,
        DEFAULT_RULES: DEFAULT_RULES,
        // 内部暴露，便于测试与复用
        _internals: {
            tokenize: tokenize,
            splitMultipleTafs: splitMultipleTafs,
            splitByAirportMarker: splitByAirportMarker,
            extractTafsInBlock: extractTafsInBlock,
            parseTafBlock: parseTafBlock,
            parseHeader: parseHeader,
            parseWind: parseWind,
            parseVisibility: parseVisibility,
            parseWeather: parseWeather,
            parseCloud: parseCloud,
            parseTemperatureGroup: parseTemperatureGroup,
            formatPeriod: formatPeriod,
            compareIssue: compareIssue
        }
    };

    global.TafParser = TafParser;
})(window);
