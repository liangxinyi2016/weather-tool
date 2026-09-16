/**
 * 气象报文翻译模块（WeatherTranslator）
 * --------------------------------------------------------------------
 * 设计目标
 *   1. 识别 METAR / SPECI / TAF 报文（兼容裸报：未声明类型）
 *   2. 将报文要素翻译为自然语言中文长句
 *   3. 复用 parsing-rules.js 的单位换算与 CAVOK 判定
 *   4. TAF 报文委托给 TafParser 解析，再对各变化组逐条翻译
 *   5. 失败时返回 { ok:false, error }，便于 UI 给出错误提示
 *
 * 暴露对象：window.WeatherTranslator
 *   - detectType(text)
 *   - parseMetar(text, type)         // 解析 METAR / SPECI
 *   - parseTaf(text)                 // 委托 TafParser.parse
 *   - toChinese(parsed, meta)        // 渲染中文
 *   - translate(input)               // 入口：detect → parse → toChinese
 *   - buildSummary(parsed)           // 生成解析摘要（要素表）
 */
(function (global) {
    'use strict';

    /* ============================================================
     * 常量：基础数据
     * ============================================================ */

    /** 云类型中文名（FEW/SCT/BKN/OVC/VV） */
    var CLOUD_NAME = {
        'FEW': '少云',
        'SCT': '疏云',
        'BKN': '多云',
        'OVC': '阴天',
        'VV':  '垂直能见度'
    };

    /** 云附加类型中文名（CB/TCU） */
    var CLOUD_CB_NAME = {
        'CB':  '积雨云',
        'TCU': '浓积云'
    };

    /** 天气现象代码 → 中文（覆盖常见项） */
    var WEATHER_NAME = {
        // 降水现象
        'DZ':  '毛毛雨',
        'RA':  '雨',
        'SN':  '雪',
        'SG':  '米雪',
        'PL':  '冰丸',
        'GR':  '冰雹',
        'GS':  '小冰雹',
        'UP':  '不明降水',
        // 视程障碍现象
        'BR':  '轻雾',
        'FG':  '雾',
        'FU':  '烟',
        'VA':  '火山灰',
        'DU':  '浮尘',
        'SA':  '扬沙',
        'SS':  '沙暴',
        'DS':  '尘暴',
        'HZ':  '霾',
        // 描述符
        'TS':  '雷暴',
        'SH':  '阵性',
        'FZ':  '冻',
        'BL':  '高吹',
        'DR':  '低吹',
        'MI':  '浅',
        'BC':  '碎片',
        'PR':  '部分',
        // 其他
        'PY':  '吹雪',
        'SQ':  '飑',
        'FC':  '漏斗云',
        'PO':  '尘卷风'
    };

    /**
     * 天气现象组合翻译规则
     * 键为代码数组顺序（如 ['TS','RA']），值为完整中文翻译
     */
    var WEATHER_COMBOS = {
        'TS+RA': '雷雨',
        'TS+SN': '雷伴雪',
        'TS+GR': '雷伴雹',
        'TS+GS': '雷伴小雹和/或霰（雪丸）',
        'SH+RA': '阵雨',
        'SH+SN': '阵雪',
        'SH+GR': '阵性雹',
        'SH+GS': '阵性小雹和/或雪丸',
        'FZ+RA': '冻雨',
        'FZ+DZ': '冻毛毛雨',
        'FZ+FG': '冻雾',
        'BL+SN': '高吹雪',
        'BL+SA': '高吹沙',
        'BL+DU': '高吹尘',
        'DR+SN': '低吹雪',
        'DR+SA': '低吹沙',
        'DR+DU': '低吹尘',
        'MI+FG': '浅雾',
        'BC+FG': '碎片雾',
        'PR+FG': '部分雾'
    };

    /** 报文类型 → 中文名 */
    var TYPE_NAME = {
        'METAR': '实况报文',
        'SPECI': '特选报',
        'TAF':   '机场预报',
    };

    /* ============================================================
     * 工具：token 切分
     * ============================================================ */

    /**
     * 把报文切成 token 数组；保留 `=` 单独成 token，便于识别末尾。
     * 同时将 `NOSIG=` / `BECMG=` 这类结尾词与 `=` 分离。
     */
    function tokenize(text) {
        if (text === null || text === undefined) return [];
        return String(text)
            .replace(/\r\n?/g, '\n')
            // 在 `=` 前后补空格，使 `NOSIG=` 拆成 ['NOSIG', '=']
            .replace(/=/g, ' = ')
            .split(/\s+/)
            .map(function (s) { return s.trim(); })
            .filter(Boolean);
    }

    /**
     * 报头类型识别
     * @returns {{ type: 'METAR'|'SPECI'|'TAF'|'NAKED', raw: string, isDeclared: boolean }}
     */
    function detectType(text) {
        var raw = String(text || '').trim();
        if (!raw) return { type: 'NAKED', raw: '', isDeclared: false };
        // 兼容 METAR/SPECI/TAF COR/AMD
        var head = raw.replace(/^(\s*|\n+)/, '').split(/\s+/)[0];
        if (head === 'METAR') return { type: 'METAR', raw: raw, isDeclared: true };
        if (head === 'SPECI') return { type: 'SPECI', raw: raw, isDeclared: true };
        if (head === 'TAF')   return { type: 'TAF',   raw: raw, isDeclared: true };
        // 裸报：默认按 METAR 处理
        return { type: 'METAR', raw: raw, isDeclared: false };
    }

    /* ============================================================
     * 工具：地点名
     * ============================================================ */

    /**
     * 获取机场中文名（若可查）
     * 优先使用 airports.js 的 getNameByIcao；未命中则返回 ICAO 本身。
     * 注：长句输出仅使用 ICAO（匹配用户示例风格），机场名展示在解析摘要中。
     */
    function getAirportName(icao) {
        if (!icao) return '';
        if (global.AirportTemplate && typeof global.AirportTemplate.getNameByIcao === 'function') {
            return global.AirportTemplate.getNameByIcao(icao) || icao;
        }
        return icao;
    }

    /** 主输出使用：仅返回 ICAO 本身（不附带中文机场名） */
    function getIcaoOnly(icao) {
        if (!icao) return '';
        return String(icao).toUpperCase();
    }

    /* ============================================================
     * 工具：时间
     * ============================================================ */

    /**
     * UTC → 北京时（+8h）换算
     * @param {number} day  UTC 日（1-31）
     * @param {number} hour UTC 时（0-23）
     * @param {number} min  UTC 分（0-59）
     * @param {Date}   refDate 参考日期（用于确定 UTC 年月，便于处理跨月/跨年）
     * @returns {{ day:number, hour:number, min:number, nextDay:boolean, nextMonth:boolean, nextYear:boolean }}
     */
    function toBeijingTime(day, hour, min, refDate) {
        var ref = refDate || new Date();
        var utc = new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), day, hour, min || 0));
        var bj = new Date(utc.getTime() + 8 * 3600 * 1000);
        var utcBefore = new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), day));
        return {
            day: bj.getUTCDate(),
            hour: bj.getUTCHours(),
            min: bj.getUTCMinutes(),
            nextDay: bj.getUTCDate() !== utcBefore.getUTCDate(),
            nextMonth: bj.getUTCMonth() !== utcBefore.getUTCMonth(),
            nextYear: bj.getUTCFullYear() !== utcBefore.getUTCFullYear()
        };
    }

    /**
     * 格式化 DDHHMM 形式（参照示例："14日2000"）
     */
    function pad2(n) { return n < 10 ? '0' + n : '' + n; }

    function formatUtcStamp(day, hour, min) {
        return day + '日' + pad2(hour) + pad2(min || 0);
    }

    function formatBjtStamp(bj, prefix) {
        return (prefix || '北京时间') + bj.day + '日' + pad2(bj.hour) + pad2(bj.min);
    }

    /**
     * 渲染发报时间文本：UTC + 括号北京时
     */
    function formatIssueTime(issue, refDate) {
        var utcStr = formatUtcStamp(issue.day, issue.hour, issue.min || 0);
        var bj = toBeijingTime(issue.day, issue.hour, issue.min || 0, refDate);
        var bjStr = formatBjtStamp(bj, '北京时间');
        return utcStr + '（' + bjStr + '）';
    }

    /**
     * TAF 有效时段：{startDay, startHour, endDay, endHour} → 文本
     * 例：1421/1509 → "14日2100至15日0900（北京时间）"
     */
    function formatValidPeriod(period, refDate) {
        if (!period) return '';
        var sUtc = formatUtcStamp(period.startDay, period.startHour, 0);
        var eUtc = formatUtcStamp(period.endDay, period.endHour, 0);
        var sBj = toBeijingTime(period.startDay, period.startHour, 0, refDate);
        var eBj = toBeijingTime(period.endDay, period.endHour, 0, refDate);
        var bjRange = formatBjtStamp(sBj, '北京时间') + '至' +
                      (eBj.nextDay || eBj.nextMonth || eBj.nextYear
                          ? formatBjtStamp(eBj, '')
                          : (eBj.day + '日' + pad2(eBj.hour) + '00'));
        return sUtc + '至' + eUtc + '（' + bjRange + '）';
    }

    /* ============================================================
     * 工具：风组
     * ============================================================ */

    /**
     * 解析风组：00000KT / 25015G25KT / 20003MPS / VRB03MPS
     * 委托给 TafParser._internals.parseWind 以保持规则一致
     */
    function parseWind(token) {
        if (global.TafParser && global.TafParser._internals && global.TafParser._internals.parseWind) {
            return global.TafParser._internals.parseWind(token);
        }
        // 兜底：自行实现
        var m = token.match(/^(\d{3}|VRB)(\d{2,3})(G(\d{2,3}))?(KT|MPS)$/);
        if (!m) return null;
        var direction = m[1];
        var speedRaw = parseInt(m[2], 10);
        var gustRaw = m[4] ? parseInt(m[4], 10) : null;
        var unit = m[5];
        var KT_TO_MS = 0.514444;
        var speedMs = unit === 'KT' ? Math.round(speedRaw * KT_TO_MS * 10) / 10 : Math.round(speedRaw * 10) / 10;
        var gustMs = gustRaw !== null ? (unit === 'KT' ? Math.round(gustRaw * KT_TO_MS * 10) / 10 : Math.round(gustRaw * 10) / 10) : null;
        return {
            direction: direction, speedRaw: speedRaw, speedMs: speedMs,
            gustRaw: gustRaw, gustMs: gustMs, unit: unit,
            variable: direction === 'VRB', calm: direction === '000' && speedRaw === 0
        };
    }

    /**
     * 把风对象翻译成中文
     * - 静风：静风
     * - VRB：风向不定，风速 # m/s
     * - 其他：风向 #°，风速 # m/s（[+ 阵风 # m/s]）
     */
    function formatWind(wind) {
        if (!wind) return '';
        if (wind.calm) return '静风';
        var parts = [];
        if (wind.variable) {
            parts.push('风向不定');
        } else {
            parts.push('风向' + wind.direction + '°');
        }
        parts.push('风速' + wind.speedMs + '米/秒');
        if (wind.gustMs !== null && wind.gustMs !== undefined) {
            parts.push('阵风' + wind.gustMs + '米/秒');
        }
        // 风向变化范围（090V200）单独描述
        if (wind.directionVariable && wind.directionFrom !== undefined && wind.directionTo !== undefined) {
            parts.push('风向在' + wind.directionFrom + '°到' + wind.directionTo + '°之间变化');
        }
        return parts.join('，');
    }

    /* ============================================================
     * 工具：能见度
     * ============================================================ */

    /**
     * 解析能见度字符串：
     *   - 'CAVOK'  → { raw:'CAVOK', meters:10000, cavok:true }
     *   - '9999'   → 10 km 以上
     *   - '0000'   → 不足 100 米
     *   - 4 位数字 → 米（≤ 5000 直接输出米，否则 km 保留 1 位）
     */
    function parseVisibility(token) {
        if (!token) return null;
        if (token === 'CAVOK') {
            return { raw: 'CAVOK', meters: ParsingRules.CAVOK_VISIBILITY, cavok: true };
        }
        if (/^\d{4}$/.test(token)) {
            var m = parseInt(token, 10);
            return { raw: token, meters: m, cavok: false };
        }
        return null;
    }

    function formatVisibility(vis) {
        if (!vis) return '';
        if (vis.cavok) {
            // CAVOK（ICAO Doc 4444 §4.3.6）：
            //   能见度≥10000米，1500米或者最高的最低扇区高度(两者取其大)以下无云，
            //   且天空没有积雨云或浓积云，无天气现象。
            // 阈值取自 ParsingRules.CAVOK_CLOUD_THRESHOLD_M。
            return '能见度≥10000米，' + ParsingRules.CAVOK_CLOUD_THRESHOLD_M +
                '米或者最高的最低扇区高度(两者取其大)以下无云，且天空没有积雨云或浓积云，无天气现象';
        }
        if (vis.meters === 9999) return '能见度10km以上';
        if (vis.meters === 0) return '能见度不足100米';
        if (vis.meters <= 5000) return '能见度' + vis.meters + '米';
        var km = Math.round(vis.meters / 100) / 10;
        return '能见度' + km + 'km';
    }

    /* ============================================================
     * 工具：天气现象
     * ============================================================ */

    function parseWeather(token) {
        if (global.TafParser && global.TafParser._internals && global.TafParser._internals.parseWeather) {
            return global.TafParser._internals.parseWeather(token);
        }
        return null;
    }

    /**
     * 把一组天气现象翻译为中文短句：
     *   1. 优先按组合规则（WEATHER_COMBOS）整体翻译（如 TS+RA → 雷雨）
     *   2. 强度规则：
     *       - TS+RA 雷雨组合：强/中/弱（用户指定）
     *       - SH 类（阵性）组合：强/小/无前缀
     *       - 其他组合：不带强度
     *   3. 多个现象用"，"分隔（输出"天气X，天气Y"）
     *   注：过去天气（RE 前缀）已在 parseMetar 中分离到 pastWeather，不在此处理
     */
    function formatWeather(weatherList) {
        if (!weatherList || weatherList.length === 0) return '';
        var phrases = [];
        for (var i = 0; i < weatherList.length; i++) {
            var w = weatherList[i];
            if (!w || !w.codes || w.codes.length === 0) continue;

            // 构造组合键
            var comboKey = w.codes.join('+');

            // TS+RA 雷雨组合：使用单独的强度翻译规则
            if (comboKey === 'TS+RA') {
                var intensity;
                if (w.intensity === '+') intensity = '强';
                else if (w.intensity === '-') intensity = '弱';
                else intensity = '中';
                phrases.push(intensity + '雷雨');
                continue;
            }

            // SH 类（阵性）组合：使用"强/小/无"强度规则
            var isShCombo = comboKey.indexOf('SH+') === 0;
            if (isShCombo && WEATHER_COMBOS[comboKey]) {
                var shIntensity = w.intensity === '+' ? '强' : (w.intensity === '-' ? '小' : '');
                phrases.push(shIntensity + WEATHER_COMBOS[comboKey]);
                continue;
            }

            // 其他组合（如 FZ+FG、BL+SN 等）使用组合翻译表，不带强度
            if (WEATHER_COMBOS[comboKey]) {
                phrases.push(WEATHER_COMBOS[comboKey]);
                continue;
            }

            // 单个或非标准组合：按代码拼接
            var intensityOther = w.intensity === '+' ? '强' : (w.intensity === '-' ? '小' : '');
            var parts = [];
            for (var j = 0; j < w.codes.length; j++) {
                var code = w.codes[j];
                if (WEATHER_NAME[code]) parts.push(WEATHER_NAME[code]);
            }
            if (parts.length === 0) continue;
            phrases.push(intensityOther + parts.join(''));
        }
        return phrases.length > 0 ? '天气' + phrases.join('，') : '';
    }

    /* ============================================================
     * 工具：云
     * ============================================================ */

    function parseCloud(token) {
        if (global.TafParser && global.TafParser._internals && global.TafParser._internals.parseCloud) {
            return global.TafParser._internals.parseCloud(token);
        }
        return null;
    }

    /**
     * 把云组翻译为"少云，云底高600米"形式（逗号分隔）
     * 当带 CB/TCU 时输出"少云积雨云，云底高1200米"
     */
    function formatClouds(clouds) {
        if (!clouds || clouds.length === 0) return '';
        var phrases = [];
        for (var i = 0; i < clouds.length; i++) {
            var c = clouds[i];
            if (!c) continue;
            // NSC：无重要云（5000ft 或 1500m 以下无显著云，且无 CB/TCU）
            // 防御性同时检查 semantic 字段与 c.type，兼容未升级 parseCloud 的历史数据。
            if (c.semantic === 'no-cloud-below-threshold' || c.type === 'NSC') {
                phrases.push('无重要云');
                continue;
            }
            // SKC / NCD / CLR 视为简洁"无云"
            if (c.type === 'SKC' || c.type === 'NCD' || c.type === 'CLR') {
                phrases.push('无云（' + c.type + '）');
                continue;
            }
            var name = CLOUD_NAME[c.type] || c.type;
            // 合并 CB/TCU 附加类型：少云积雨云 / 疏云浓积云
            if (c.cb && CLOUD_CB_NAME[c.cb]) {
                name = name + CLOUD_CB_NAME[c.cb];
            }
            var heightTxt;
            if (c.height === null || c.height === undefined) {
                heightTxt = '云底高不明';
            } else {
                var meters = ParsingRules.cloudHeightToMeters(Math.round(c.height / 100));
                heightTxt = '云底高' + meters + '米';
            }
            phrases.push(name + '，' + heightTxt);
        }
        return phrases.join('，');
    }

    /* ============================================================
     * 工具：温露点
     * ============================================================ */

    /**
     * 解析温露点 token：19/17 / M02/M05
     * @returns {{ t:number, td:number, raw:string } | null}
     */
    function parseTempDew(token) {
        if (!token) return null;
        var m = token.match(/^(M?\d{2})\/(M?\d{2})$/);
        if (!m) return null;
        function toNum(s) { return s[0] === 'M' ? -parseInt(s.substring(1), 10) : parseInt(s, 10); }
        return { t: toNum(m[1]), td: toNum(m[2]), raw: token };
    }

    function formatTempDew(td) {
        if (!td) return '';
        return '气温' + td.t + '℃，露点' + td.td + '℃';
    }

    /* ============================================================
     * 工具：气压
     * ============================================================ */

    /**
     * 解析气压：Q1017 / A2992
     */
    function parsePressure(token) {
        if (!token) return null;
        var m = token.match(/^Q(\d{4})$/);
        if (m) return { type: 'Q', value: parseInt(m[1], 10), raw: token };
        var m2 = token.match(/^A(\d{4})$/);
        if (m2) return { type: 'A', value: parseInt(m2[1], 10) / 100, raw: token };
        return null;
    }

    function formatPressure(p) {
        if (!p) return '';
        if (p.type === 'Q') return '修正海平面气压' + p.value + 'hPa';
        if (p.type === 'A') return '修正海平面气压' + p.value + 'inHg';
        return '修正海平面气压' + p.raw;
    }

    /* ============================================================
     * 工具：变化趋势
     * ============================================================ */

    function formatTrend(token) {
        if (!token) return '';
        if (token === 'NOSIG') return '未来两小时无变化';
        if (token === 'NSW') return '无重要天气';
        if (token === 'NSC') return '无重要云';
        if (token === 'BECMG') return '渐变为';
        if (token === 'TEMPO') return '短时波动为';
        return token;
    }

    /**
     * 格式化 METAR 趋势预报的完整中文翻译
     * BECMG 时间规则：
     *   FMhhmm only：   从 FMhhmm 到 (发报时间+2小时) 渐变为
     *   TLhhmm only：   从 (发报时间) 到 TLhhmm 渐变为
     *   AThhmm only：   在 AThhmm 渐变为
     *   FM + TL：       从 FMhhmm 到 TLhhmm 渐变为
     *   AT only：       在 AThhmm 渐变为
     * TEMPO 时间规则同上，仅类型词改为"短时波动为"
     * BECMG 2418/2445 范围：直接显示原值
     * 后接 [风]，[能见度]，[天气]，[云] 等要素
     */
    function formatTrendDetail(trendData, refDate) {
        if (!trendData) return '';
        var typeName = trendData.type === 'BECMG' ? '渐变为' : '短时波动为';
        var parts = [];

        // 构造结束时间的辅助：发报时间 + 2 小时
        function plusTwoHours() {
            if (!refDate || refDate.hour === undefined) return null;
            var h = (refDate.hour + 2) % 24;
            // 兼容字段名：minute（趋势时间）或 min（发报时间 issue）
            var m = refDate.minute !== undefined ? refDate.minute : (refDate.min || 0);
            return pad2(h) + pad2(m);
        }

        // 时间部分
        var fromStr = null;
        var toStr = null;
        var atStr = null;

        if (trendData.fromTime) {
            fromStr = pad2(trendData.fromTime.hour) + pad2(trendData.fromTime.minute);
        }
        if (trendData.toTime) {
            toStr = pad2(trendData.toTime.hour) + pad2(trendData.toTime.minute);
        }
        if (trendData.atTime) {
            atStr = pad2(trendData.atTime.hour) + pad2(trendData.atTime.minute);
        }

        // 优先级：DDHH/DDHH 范围 > FM+TL > AT only > FM only > TL only
        if (trendData.fromDayHour && trendData.toDayHour) {
            // DDHH/DDHH 范围（如 2516/2519 → 25日16时至25日19时，含北京时对照）
            var fromD = parseInt(trendData.fromDayHour.substring(0, 2), 10);
            var fromH = parseInt(trendData.fromDayHour.substring(2, 4), 10);
            var toD = parseInt(trendData.toDayHour.substring(0, 2), 10);
            var toH = parseInt(trendData.toDayHour.substring(2, 4), 10);
            // 计算北京时（UTC + 8 小时）
            var fromBjTotalH = fromH + 8;
            var fromBjDay = fromD + Math.floor(fromBjTotalH / 24);
            var fromBjHour = fromBjTotalH % 24;
            var toBjTotalH = toH + 8;
            var toBjDay = toD + Math.floor(toBjTotalH / 24);
            var toBjHour = toBjTotalH % 24;
            var rangeTxt = fromD + '日' + pad2(fromH) + '00至' + toD + '日' + pad2(toH) + '00';
            var bjtTxt = '（北京时间' + fromBjDay + '日' + pad2(fromBjHour) + '00至北京时间' + toBjDay + '日' + pad2(toBjHour) + '00）';
            parts.push(rangeTxt + bjtTxt + typeName);
        } else if (fromStr && toStr) {
            // FM + TL：从 FM 到 TL
            parts.push('从' + fromStr + '到' + toStr + typeName);
        } else if (atStr) {
            // AT only：在 AT
            parts.push('在' + atStr + typeName);
        } else if (fromStr) {
            // FM only：从 FM 到 (发报时间+2小时)
            var end1 = plusTwoHours();
            if (end1) {
                parts.push('从' + fromStr + '到' + end1 + typeName);
            } else {
                parts.push('从' + fromStr + typeName);
            }
        } else if (toStr) {
            // TL only：从 (发报时间) 到 TL
            if (refDate && refDate.hour !== undefined) {
                var refMin = refDate.minute !== undefined ? refDate.minute : (refDate.min || 0);
                var startStr = pad2(refDate.hour) + pad2(refMin);
                parts.push('从' + startStr + '到' + toStr + typeName);
            } else {
                parts.push('到' + toStr + typeName);
            }
        } else {
            // 无时间信息
            parts.push(typeName);
        }

        // 风
        if (trendData.wind) {
            var wTxt = formatWind(trendData.wind);
            if (wTxt) parts.push(wTxt);
        }
        // 能见度
        if (trendData.visibility) {
            parts.push(formatVisibility(trendData.visibility));
        }
        // 天气现象
        var wTxt2 = formatWeather(trendData.weather);
        if (wTxt2) parts.push(wTxt2);
        // 云
        var cTxt = formatClouds(trendData.clouds);
        if (cTxt) parts.push(cTxt);
        // NSW：无重要天气（趋势内标记）
        if (trendData.nsw) {
            parts.push('无重要天气');
        }
        // NSC：无重要云（趋势内标记）
        if (trendData.nsc) {
            parts.push('无重要云');
        }

        return parts.join('，');
    }

    /* ============================================================
     * METAR / SPECI 解析
     * ============================================================ */

    /**
     * 解析单条 METAR / SPECI 报文
     * @param {string} text
     * @param {string} type  'METAR' | 'SPECI' | 'NAKED'
     * @returns {object} parsed
     */
    function parseMetar(text, type) {
        var tokens = tokenize(text);
        var result = {
            type: type || 'METAR',
            isDeclared: type === 'METAR' || type === 'SPECI',
            icao: null,
            issue: null,
            wind: null,
            visibility: null,
            weather: [],
            pastWeather: [],
            clouds: [],
            tempDew: null,
            pressure: null,
            trend: null,
            trendDetail: null,
            rawTokens: tokens.slice()
        };

        var i = 0;
        // 跳过 METAR / SPECI 前缀
        if (tokens[i] === 'METAR' || tokens[i] === 'SPECI') i++;
        // COR / AMD
        if (tokens[i] === 'COR' || tokens[i] === 'AMD') i++;
        // ICAO
        if (i < tokens.length && /^[A-Z]{4}$/.test(tokens[i])) {
            result.icao = tokens[i++];
        } else {
            throw new Error('未找到 ICAO（4 字母机场代码）');
        }
        // 发报时间 DDHHMMZ
        if (i < tokens.length && /^\d{6}Z$/.test(tokens[i])) {
            var t = tokens[i++];
            result.issue = {
                day: parseInt(t.substring(0, 2), 10),
                hour: parseInt(t.substring(2, 4), 10),
                min: parseInt(t.substring(4, 6), 10),
                raw: t
            };
        } else {
            throw new Error('未找到发报时间（应为 DDHHMMZ 形式）');
        }

        // 主组要素：顺序扫描
        while (i < tokens.length) {
            var tk = tokens[i];
            if (tk === '=') { i++; break; }
            // 风组
            if (!result.wind) {
                var w = parseWind(tk);
                if (w) { 
                    result.wind = w; 
                    i++; 
                    // 检查是否有风向变化范围（如 090V200）
                    if (i < tokens.length && /^\d{3}V\d{3}$/.test(tokens[i])) {
                        var vMatch = tokens[i].match(/^(\d{3})V(\d{3})$/);
                        result.wind.directionFrom = parseInt(vMatch[1], 10);
                        result.wind.directionTo = parseInt(vMatch[2], 10);
                        result.wind.directionVariable = true;
                        i++;
                    }
                    continue; 
                }
            }
            // CAVOK
            if (tk === 'CAVOK') {
                result.visibility = { raw: 'CAVOK', meters: ParsingRules.CAVOK_VISIBILITY, cavok: true };
                i++; continue;
            }
            // 能见度（4 位）
            if (!result.visibility) {
                var v = parseVisibility(tk);
                if (v) { result.visibility = v; i++; continue; }
            }
            // 天气现象（RE 前缀的过去天气单独存到 pastWeather）
            var ph = parseWeather(tk);
            if (ph) {
                if (ph.isRecent) {
                    result.pastWeather.push(ph);
                } else {
                    result.weather.push(ph);
                }
                i++;
                continue;
            }
            // 云（NSC 仅在 BECMG/TEMPO 趋势内处理，主报中遇到 NSC 时跳过）
            if (tk === 'NSC') {
                // 如果 NSC 之前是 BECMG/TEMPO（趋势组），则不作为主报云组
                var prevTk = i > 0 ? tokens[i - 1] : null;
                if (prevTk === 'NSW' || prevTk === 'BECMG' || prevTk === 'TEMPO' ||
                    /^FM\d{4}$/.test(prevTk) || /^TL\d{4}$/.test(prevTk) || /^AT\d{4}$/.test(prevTk)) {
                    // 让趋势循环处理 NSC
                    i++;
                    continue;
                }
            }
            var c = parseCloud(tk);
            if (c) { result.clouds.push(c); i++; continue; }
            // 温露点
            if (!result.tempDew) {
                var td = parseTempDew(tk);
                if (td) { result.tempDew = td; i++; continue; }
            }
            // 气压
            if (!result.pressure) {
                var p = parsePressure(tk);
                if (p) { result.pressure = p; i++; continue; }
            }
            // 趋势：NOSIG（无显著变化）/ BECMG（渐变）/ TEMPO（短时波动）
            // 优先级：先识别 BECMG/TEMPO，让其内循环能消费后面的 NSW/NSC 等子标记
            if (tk === 'NOSIG') {
                result.trend = tk;
                i++;
                continue;
            }
            if (tk === 'BECMG' || tk === 'TEMPO') {
                var trendType = tk;
                i++;
                var trendData = {
                    type: trendType,
                    fromTime: null,
                    toTime: null,
                    atTime: null,
                    fromDayHour: null,
                    toDayHour: null,
                    wind: null,
                    visibility: null,
                    weather: [],
                    clouds: [],
                    nsw: false,
                    nsc: false
                };
                // 解析趋势时间和要素，直到遇到 = 或下一个趋势词
                // 注意：NSW/NSC 是趋势内的子标记，不应触发 break
                while (i < tokens.length) {
                    var ttk = tokens[i];
                    if (ttk === '=') break;
                    if (ttk === 'BECMG' || ttk === 'TEMPO' || ttk === 'NOSIG') break;
                    // 时间：FMhhmm / TLhhmm / AThhmm
                    if (/^FM\d{4}$/.test(ttk)) {
                        trendData.fromTime = {
                            hour: parseInt(ttk.substring(2, 4), 10),
                            minute: parseInt(ttk.substring(4, 6), 10),
                            raw: ttk
                        };
                        i++;
                        continue;
                    }
                    if (/^TL\d{4}$/.test(ttk)) {
                        trendData.toTime = {
                            hour: parseInt(ttk.substring(2, 4), 10),
                            minute: parseInt(ttk.substring(4, 6), 10),
                            raw: ttk
                        };
                        i++;
                        continue;
                    }
                    if (/^AT\d{4}$/.test(ttk)) {
                        trendData.atTime = {
                            hour: parseInt(ttk.substring(2, 4), 10),
                            minute: parseInt(ttk.substring(4, 6), 10),
                            raw: ttk
                        };
                        i++;
                        continue;
                    }
                    // 日期/小时格式：DDHH/DDHH（如 2418/2445 表示24日18时到24日45时... 即24日18时到25日00时（24日+24小时=25日00时，但 2445 表示24日45时 = 25日21时？实际是 24日45时? 似乎不规范）
                    // 实际规范是 DDHH 格式（日期+小时），2445 应该是 25 日 21 时（24+1=25日 24+21=45时）
                    // 不过用户规则是直接显示原值 "从2418到2445"
                    if (/^\d{4}\/\d{4}$/.test(ttk)) {
                        var rangeMatch = ttk.match(/^(\d{4})\/(\d{4})$/);
                        trendData.fromDayHour = rangeMatch[1]; // DDHH 格式
                        trendData.toDayHour = rangeMatch[2];
                        i++;
                        continue;
                    }
                    // 风
                    if (!trendData.wind) {
                        var tw = parseWind(ttk);
                        if (tw) {
                            trendData.wind = tw;
                            i++;
                            // 检查是否有风向变化范围（如 090V200）
                            if (i < tokens.length && /^\d{3}V\d{3}$/.test(tokens[i])) {
                                var vMatch2 = tokens[i].match(/^(\d{3})V(\d{3})$/);
                                trendData.wind.directionFrom = parseInt(vMatch2[1], 10);
                                trendData.wind.directionTo = parseInt(vMatch2[2], 10);
                                trendData.wind.directionVariable = true;
                                i++;
                            }
                            continue;
                        }
                    }
                    // 能见度
                    if (!trendData.visibility) {
                        var tv = parseVisibility(ttk);
                        if (tv) { trendData.visibility = tv; i++; continue; }
                    }
                    // NSW：无重要天气（趋势内标记）
                    if (ttk === 'NSW') {
                        trendData.nsw = true;
                        i++;
                        continue;
                    }
                    // NSC：无重要云（趋势内标记）
                    if (ttk === 'NSC') {
                        trendData.nsc = true;
                        i++;
                        continue;
                    }
                    // 天气现象
                    var tph = parseWeather(ttk);
                    if (tph) { trendData.weather.push(tph); i++; continue; }
                    // 云
                    var tc = parseCloud(ttk);
                    if (tc) { trendData.clouds.push(tc); i++; continue; }
                    // 未知 token：跳过
                    i++;
                }
                result.trend = trendType;
                result.trendDetail = trendData;
                continue;
            }
            // 未知 token：跳过以避免错位（防御）
            i++;
        }

        return result;
    }

    /* ============================================================
     * 翻译：METAR / SPECI → 中文长句
     * ============================================================ */

    function metarToChinese(parsed, refDate) {
        var typeName = TYPE_NAME[parsed.type] || '报文';
        var icao = getIcaoOnly(parsed.icao);
        var parts = [];

        // 1. 报头
        if (parsed.isDeclared) {
            parts.push(icao + typeName);
        } else {
            // 裸报：注明"未声明类型，按 METAR 处理"
            parts.push(icao + '（未声明类型，按 METAR ' + typeName + '处理）');
        }

        // 2. 发报时间
        if (parsed.issue) {
            parts.push('发报时间' + formatIssueTime(parsed.issue, refDate));
        }

        // 3. 风
        if (parsed.wind) {
            var windTxt = formatWind(parsed.wind);
            if (windTxt) parts.push(windTxt);
        }

        // 4. 能见度
        if (parsed.visibility) {
            parts.push(formatVisibility(parsed.visibility));
        }

        // 5. 天气现象
        var weatherTxt = formatWeather(parsed.weather);
        if (weatherTxt) parts.push(weatherTxt);

        // 6. 云
        var cloudTxt = formatClouds(parsed.clouds);
        if (cloudTxt) parts.push(cloudTxt);

        // 7. 温露点
        if (parsed.tempDew) {
            parts.push(formatTempDew(parsed.tempDew));
        }

        // 8. 气压
        if (parsed.pressure) {
            parts.push(formatPressure(parsed.pressure));
        }

        // 8.5 过去天气（RE 前缀，按报文原始顺序在 NOSIG 之前显示）
        if (parsed.pastWeather && parsed.pastWeather.length) {
            parts.push(formatPastWeather(parsed.pastWeather));
        }

        // 9. 趋势
        if (parsed.trendDetail) {
            var tdTxt = formatTrendDetail(parsed.trendDetail, parsed.issue);
            if (tdTxt) parts.push(tdTxt);
        } else if (parsed.trend) {
            var tTxt = formatTrend(parsed.trend);
            if (tTxt) parts.push(tTxt);
        }

        return parts.join('，') + '。';
    }

    /**
     * 把过去天气现象（RE 前缀）翻译为中文短句：
     *   - 直接拼接为"观测前出现..."格式
     *   - 多个现象用"，"分隔（输出"观测前出现X，观测前出现Y"）
     */
    function formatPastWeather(pastList) {
        if (!pastList || pastList.length === 0) return '';
        var phrases = [];
        for (var i = 0; i < pastList.length; i++) {
            var w = pastList[i];
            if (!w || !w.codes || w.codes.length === 0) continue;
            var comboKey = w.codes.join('+');

            // TS+RA 雷雨组合
            if (comboKey === 'TS+RA') {
                var intensity;
                if (w.intensity === '+') intensity = '强';
                else if (w.intensity === '-') intensity = '弱';
                else intensity = '中';
                phrases.push('观测前出现' + intensity + '雷雨');
                continue;
            }

            // SH 类（阵性）组合
            var isShCombo = comboKey.indexOf('SH+') === 0;
            if (isShCombo && WEATHER_COMBOS[comboKey]) {
                var shIntensity = w.intensity === '+' ? '强' : (w.intensity === '-' ? '小' : '');
                phrases.push('观测前出现' + shIntensity + WEATHER_COMBOS[comboKey]);
                continue;
            }

            // 其他组合
            if (WEATHER_COMBOS[comboKey]) {
                phrases.push('观测前出现' + WEATHER_COMBOS[comboKey]);
                continue;
            }

            // 单个或非标准组合：按代码拼接
            var intensityOther = w.intensity === '+' ? '强' : (w.intensity === '-' ? '小' : '');
            var parts = [];
            for (var j = 0; j < w.codes.length; j++) {
                var code = w.codes[j];
                if (WEATHER_NAME[code]) parts.push(WEATHER_NAME[code]);
            }
            if (parts.length === 0) continue;
            phrases.push('观测前出现' + intensityOther + parts.join(''));
        }
        return phrases.length > 0 ? phrases.join('，') : '';
    }

    /* ============================================================
     * TAF 翻译
     * ============================================================ */

    /**
     * 委托 TafParser 解析，再对每段（主组 + 变化组）逐条翻译
     * @returns {object} { chinese:string, parsed:object }
     */
    function tafToChinese(parsedTaf, refDate) {
        var sel = parsedTaf.selected || parsedTaf.reports[0];
        if (!sel) throw new Error('TAF 解析失败：未选中任何报文');

        var icao = getIcaoOnly(sel.icao);
        var parts = [];

        // 1. 报头
        var typeName = TYPE_NAME['TAF'];
        var headSuffix = '';
        if (sel.isAmd) headSuffix = '（修订）';
        else if (sel.isCor) headSuffix = '（更正）';
        parts.push(icao + typeName + headSuffix);

        // 2. 发布时间
        if (sel.issue) {
            parts.push('发布时间' + formatIssueTime(sel.issue, refDate));
        }

        // 3. 有效时段
        if (sel.validPeriod) {
            parts.push('有效时段' + formatValidPeriod(sel.validPeriod, refDate));
        }

        // 4. 主组要素
        var main = sel.main || {};
        var mainWind = formatWind(main.wind);
        if (mainWind) parts.push('主组' + mainWind);
        if (main.visibility) {
            parts.push(formatVisibility(main.visibility));
        }
        var mainWeather = formatWeather(main.weather);
        if (mainWeather) parts.push(mainWeather);
        var mainClouds = formatClouds(main.clouds);
        if (mainClouds) parts.push(mainClouds);

        // 温度组（如果有）
        if (sel.tmax !== null && sel.tmax !== undefined) {
            parts.push('最高气温' + sel.tmax + '℃');
        }
        if (sel.tmin !== null && sel.tmin !== undefined) {
            parts.push('最低气温' + sel.tmin + '℃');
        }

        // 5. 变化组
        if (sel.changes && sel.changes.length > 0) {
            for (var k = 0; k < sel.changes.length; k++) {
                var ch = sel.changes[k];
                var label = ch.type; // BECMG / TEMPO / PROB30 / PROB40 / FM
                var segParts = [];

                // 时段
                if (ch.period) {
                    if (ch.type === 'FM') {
                        segParts.push(formatUtcStamp(ch.period.startDay, ch.period.startHour, 0));
                    } else {
                        segParts.push(formatValidPeriod(ch.period, refDate));
                    }
                }

                // 要素
                var chWind = formatWind(ch.wind);
                if (chWind) segParts.push(chWind);
                if (ch.visibility) segParts.push(formatVisibility(ch.visibility));
                var chWeather = formatWeather(ch.weather);
                if (chWeather) segParts.push(chWeather);
                var chClouds = formatClouds(ch.clouds);
                if (chClouds) segParts.push(chClouds);

                if (segParts.length > 0) {
                    parts.push(label + '：' + segParts.join('，'));
                }
            }
        }

        return {
            chinese: parts.join('，') + '。',
            parsed: sel,
            type: 'TAF',
            isDeclared: true
        };
    }

    /* ============================================================
     * 解析摘要（要素表）
     * ============================================================ */

    function buildSummary(parsed) {
        var rows = [];
        function add(label, value) {
            if (value !== null && value !== undefined && value !== '') {
                rows.push({ label: label, value: String(value) });
            }
        }
        if (parsed.type === 'TAF') {
            var sel = parsed.parsed;
            add('报文类型', 'TAF 机场预报');
            add('机场', sel.icao);
            add('修订/更正', sel.isAmd ? 'AMD' : (sel.isCor ? 'COR' : '—'));
            if (sel.issue) add('发布时间', sel.issue.raw);
            if (sel.validPeriod) add('有效时段', sel.validPeriod.raw);
            if (sel.main && sel.main.wind) add('主组风', formatWind(sel.main.wind));
            if (sel.main && sel.main.visibility) add('主组能见度', formatVisibility(sel.main.visibility));
            if (sel.main && sel.main.clouds && sel.main.clouds.length) {
                add('主组云况', formatClouds(sel.main.clouds));
            }
            if (sel.changes) {
                for (var i = 0; i < sel.changes.length; i++) {
                    var ch = sel.changes[i];
                    add('变化组 ' + (i + 1) + ' (' + ch.type + ')',
                        [
                            ch.wind ? formatWind(ch.wind) : '',
                            ch.visibility ? formatVisibility(ch.visibility) : '',
                            formatClouds(ch.clouds)
                        ].filter(Boolean).join('，'));
                }
            }
        } else {
            // METAR / SPECI / NAKED
            add('报文类型', (parsed.isDeclared ? '' : '未声明（按 METAR）') + (TYPE_NAME[parsed.type] || '报文'));
            add('机场', parsed.icao || '—');
            if (parsed.issue) add('发报时间', parsed.issue.raw);
            if (parsed.wind) add('风', formatWind(parsed.wind));
            if (parsed.visibility) add('能见度', formatVisibility(parsed.visibility));
            if (parsed.weather && parsed.weather.length) add('天气现象', formatWeather(parsed.weather));
            if (parsed.clouds && parsed.clouds.length) add('云况', formatClouds(parsed.clouds));
            if (parsed.tempDew) add('温露点', formatTempDew(parsed.tempDew));
            if (parsed.pressure) add('气压', formatPressure(parsed.pressure));
            if (parsed.trendDetail) {
                add('趋势', formatTrendDetail(parsed.trendDetail));
            } else if (parsed.trend) {
                add('趋势', formatTrend(parsed.trend));
            }
        }
        return rows;
    }

    /* ============================================================
     * 顶层入口
     * ============================================================ */

    /**
     * 翻译入口
     * @param {string} input
     * @returns {{ok:boolean, type?:string, chinese?:string, summary?:Array, parsed?:object, error?:string}}
     */
    function translate(input) {
        if (global.Logger) global.Logger.info('[translator] 收到翻译请求', { length: (input || '').length });
        var detection = detectType(input);
        var refDate = new Date();

        try {
            if (detection.type === 'TAF') {
                if (!global.TafParser || typeof global.TafParser.parse !== 'function') {
                    throw new Error('TafParser 未加载');
                }
                var p = global.TafParser.parse(input);
                var out = tafToChinese(p, refDate);
                if (global.Logger) global.Logger.info('[translator] TAF 翻译完成');
                return {
                    ok: true,
                    type: 'TAF',
                    chinese: out.chinese,
                    summary: buildSummary({ type: 'TAF', parsed: out.parsed }),
                    parsed: out.parsed
                };
            } else {
                // METAR / SPECI / 裸报
                var pm = parseMetar(input, detection.type);
                var txt = metarToChinese(pm, refDate);
                if (global.Logger) global.Logger.info('[translator] METAR/SPECI 翻译完成', { icao: pm.icao });
                return {
                    ok: true,
                    type: detection.type,
                    chinese: txt,
                    summary: buildSummary(pm),
                    parsed: pm
                };
            }
        } catch (e) {
            if (global.Logger) global.Logger.warn('[translator] 翻译失败', e && e.message);
            return { ok: false, error: e && e.message ? e.message : '无法识别报文类型' };
        }
    }

    /* ============================================================
     * 导出
     * ============================================================ */

    global.WeatherTranslator = {
        detectType: detectType,
        parseMetar: parseMetar,
        parseTaf: function (text) {
            if (!global.TafParser) throw new Error('TafParser 未加载');
            return global.TafParser.parse(text);
        },
        toChinese: function (parsed, refDate) {
            if (parsed && parsed.type === 'TAF') return tafToChinese(parsed, refDate || new Date());
            return metarToChinese(parsed, refDate || new Date());
        },
        translate: translate,
        translateMulti: translateMulti,
        buildSummary: buildSummary,
        exportToWord: exportToWord,
        // 暴露给测试
        _internals: {
            tokenize: tokenize,
            parseWind: parseWind,
            parseVisibility: parseVisibility,
            parseWeather: parseWeather,
            parseCloud: parseCloud,
            parseTempDew: parseTempDew,
            parsePressure: parsePressure,
            formatWind: formatWind,
            formatVisibility: formatVisibility,
            formatWeather: formatWeather,
            formatClouds: formatClouds,
            formatTempDew: formatTempDew,
            formatPressure: formatPressure,
            formatIssueTime: formatIssueTime,
            formatValidPeriod: formatValidPeriod,
            toBeijingTime: toBeijingTime,
            getAirportName: getAirportName
        }
    };

    /* ============================================================
     * 多条报文翻译
     * ============================================================ */

    /**
     * 拆分多条报文（按行或按 = 结尾拆分）
     * @param {string} input 包含多条报文的文本
     * @returns {string[]} 单条报文数组
     */
    function splitReports(input) {
        if (!input) return [];
        var text = String(input).replace(/\r\n?/g, '\n');
        var reports = [];
        var current = [];
        var lines = text.split('\n');
        
        for (var i = 0; i < lines.length; i++) {
            var line = lines[i].trim();
            if (!line) continue;
            current.push(line);
            // 报文以 = 结尾
            if (line.slice(-1) === '=') {
                reports.push(current.join(' '));
                current = [];
            }
        }
        // 处理最后一条可能没有 = 结尾的报文
        if (current.length > 0) {
            reports.push(current.join(' '));
        }
        return reports;
    }

    /**
     * 翻译多条报文
     * @param {string} input 包含多条报文的文本
     * @returns {{ok:boolean, results:Array, error?:string}}
     */
    function translateMulti(input) {
        if (global.Logger) global.Logger.info('[translator] 收到多条翻译请求', { length: (input || '').length });
        var reports = splitReports(input);
        if (reports.length === 0) {
            return { ok: false, error: '未找到有效的报文', results: [] };
        }
        
        var results = [];
        for (var i = 0; i < reports.length; i++) {
            var report = reports[i].trim();
            if (!report) continue;
            var result = translate(report);
            result.original = report;
            result.index = i + 1;
            results.push(result);
        }
        
        var allOk = results.every(function (r) { return r.ok; });
        if (global.Logger) global.Logger.info('[translator] 多条翻译完成', { count: results.length, allOk: allOk });
        return { ok: allOk, results: results };
    }

    /* ============================================================
     * 导出 Word 文档
     * ============================================================ */

    /**
     * 将翻译结果导出为 Word 文档（.docx）
     * 使用 DOCX.js 库或生成 HTML 格式（浏览器可直接打开为 Word）
     * @param {Array} results 翻译结果数组，每项包含 {original, chinese}
     * @param {string} filename 文件名
     */
    function exportToWord(results, filename) {
        if (!results || results.length === 0) {
            if (global.Logger) global.Logger.warn('[translator] 无翻译结果可导出');
            return;
        }
        
        var docContent = '<!DOCTYPE html><html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word"><head><meta charset="UTF-8"><title>气象报文翻译结果</title>';
        docContent += '<style>';
        docContent += 'body { font-family: "SimSun", "Microsoft YaHei", sans-serif; font-size: 14px; line-height: 1.8; margin: 20px; }';
        docContent += 'h1 { font-size: 18px; font-weight: bold; text-align: center; margin-bottom: 24px; color: #1a365d; }';
        docContent += '.report-section { margin-bottom: 24px; padding: 16px; border: 1px solid #e2e8f0; border-radius: 8px; background: #f8fafc; }';
        docContent += '.report-header { font-weight: bold; color: #2c5282; margin-bottom: 8px; font-size: 15px; }';
        docContent += '.original { color: #4a5568; font-family: "Courier New", monospace; margin-bottom: 8px; white-space: pre-wrap; }';
        docContent += '.chinese { color: #1a202c; margin-top: 8px; }';
        docContent += '.separator { border-top: 1px dashed #cbd5e0; margin: 16px 0; }';
        docContent += '.page-break { page-break-after: always; }';
        docContent += '</style></head><body>';
        
        docContent += '<h1>气象报文翻译结果</h1>';
        docContent += '<p style="text-align: right; color: #718096; margin-bottom: 20px;">生成时间：' + new Date().toLocaleString('zh-CN') + '</p>';
        
        for (var i = 0; i < results.length; i++) {
            var res = results[i];
            docContent += '<div class="report-section">';
            docContent += '<div class="report-header">第 ' + (i + 1) + ' 条报文</div>';
            docContent += '<div class="original"><strong>原文：</strong><br/>' + escapeHtml(res.original || '') + '</div>';
            docContent += '<div class="separator"></div>';
            docContent += '<div class="chinese"><strong>翻译：</strong><br/>' + escapeHtml(res.chinese || '(翻译失败)') + '</div>';
            docContent += '</div>';
            if (i < results.length - 1) {
                docContent += '<div class="separator"></div>';
            }
        }
        
        docContent += '</body></html>';
        
        var blob = new Blob([docContent], { type: 'application/vnd.ms-word' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = filename || ('气象报文翻译_' + (global.Exporter ? global.Exporter.stamp() : Date.now()) + '.doc');
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        setTimeout(function () {
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        }, 100);
        
        if (global.Logger) global.Logger.info('[translator] 导出 Word 成功，共 ' + results.length + ' 条');
    }

    /* ============================================================
     * UI 模块（绑定 DOM、剪贴板、最近翻译持久化）
     * ============================================================ */

    var UI = {
        MAX_RECENT: 10,
        RECENT_KEY: 'translate.recent',

        elements: null,
        lastResults: [],

        /** 初始化 UI 绑定（DOMContentLoaded 或在 app.js 启动时调用） */
        init: function () {
            var ids = [
                'translate-input', 'translate-run', 'translate-sample', 'translate-clear',
                'translate-copy', 'translate-export-word', 'translate-error', 'translate-output',
                'translate-summary', 'translate-summary-empty',
                'translate-recent', 'translate-recent-empty', 'translate-recent-count',
                'translate-recent-clear'
            ];
            this.elements = {};
            for (var i = 0; i < ids.length; i++) {
                this.elements[ids[i]] = document.getElementById(ids[i]);
            }
            if (!this.elements['translate-input']) {
                if (global.Logger) global.Logger.warn('[translator] UI 元素未找到，跳过初始化');
                return;
            }
            this.bindEvents();
            this.renderRecent();
            if (global.Logger) global.Logger.info('[translator] UI 初始化完成');
        },

        bindEvents: function () {
            var el = this.elements;
            var self = this;
            el['translate-run'].addEventListener('click', function () { self.run(); });
            el['translate-sample'].addEventListener('click', function () { self.fillSample(); });
            el['translate-clear'].addEventListener('click', function () { self.clearAll(); });
            el['translate-copy'].addEventListener('click', function () { self.copyResult(); });
            if (el['translate-export-word']) {
                el['translate-export-word'].addEventListener('click', function () { self.exportWord(); });
            }
            el['translate-recent-clear'].addEventListener('click', function () { self.clearRecent(); });
            // 快捷键：Ctrl/Cmd + Enter 触发翻译
            el['translate-input'].addEventListener('keydown', function (e) {
                if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                    e.preventDefault();
                    self.run();
                }
            });
        },

        run: function () {
            var el = this.elements;
            var text = (el['translate-input'].value || '').trim();
            if (!text) {
                this.showError('请粘贴报文后再点击"翻译"。');
                return;
            }
            var result = translateMulti(text);
            if (result.results.length === 0) {
                this.showError(result.error || '无法识别报文类型');
                this.clearOutput();
                return;
            }
            this.hideError();
            this.lastResults = result.results;
            this.renderResults(result.results);
            // 将每条成功的翻译都添加到最近记录
            for (var i = 0; i < result.results.length; i++) {
                var r = result.results[i];
                if (r.ok) {
                    this.pushRecent(r.original, r);
                }
            }
        },

        renderResults: function (results) {
            var el = this.elements;
            var hasSuccess = results.some(function (r) { return r.ok; });
            el['translate-copy'].disabled = !hasSuccess;
            if (el['translate-export-word']) {
                el['translate-export-word'].disabled = !hasSuccess;
            }
            
            var html = '';
            for (var i = 0; i < results.length; i++) {
                var r = results[i];
                html += '<div class="translate-item">';
                html += '<div class="translate-item-header">';
                html += '<span class="translate-item-number">' + (i + 1) + '</span>';
                html += '<span class="translate-item-type">' + escapeHtml(r.type || 'METAR') + '</span>';
                html += '</div>';
                if (r.ok) {
                    html += '<div class="translate-item-result">' + escapeHtml(r.chinese) + '</div>';
                } else {
                    html += '<div class="translate-item-error">' + escapeHtml(r.error || '翻译失败') + '</div>';
                }
                html += '</div>';
            }
            el['translate-output'].innerHTML = html;
        },

        clearOutput: function () {
            var el = this.elements;
            el['translate-output'].innerHTML = '<div class="translate-empty">尚未翻译。请在左侧粘贴报文后点击"翻译"。</div>';
            el['translate-copy'].disabled = true;
            if (el['translate-export-word']) {
                el['translate-export-word'].disabled = true;
            }
            // 隐藏解析摘要区域
            if (el['translate-summary']) {
                el['translate-summary'].innerHTML = '';
            }
        },

        fillSample: function () {
            var samples = [
                'METAR ZPPP 142000Z 20003MPS 9999 FEW020 SCT040 19/17 Q1017 NOSIG=',
                'METAR ZUUU 121500Z VRB03MPS 0500 R28/0700D FG VV/// 02/02 Q1020 NOSIG=',
                'SPECI ZBAA 010230Z 03015G25MPS 0500 +TSRA BKN008 OVC020 18/17 Q1005 NOSIG=',
                'TAF ZPPP 141800Z 1421/1509 20005MPS 9999 FEW020 BECMG 1500/1503 30010MPS BKN040=',
                // CAVOK METAR：演示完整 ICAO 标准输出
                'METAR ZBAA 010230Z 36008MPS CAVOK 25/14 Q1015 NOSIG=',
                // NSC TAF：演示 NSC 翻译含 1500m 阈值与无 CB/TCU 说明
                'TAF ZSPD 120300Z 1206/1312 09004MPS 6000 NSC TX18/1207Z TN10/1222Z BECMG 1212/1214 18010G15MPS='
            ];
            var current = (this.elements['translate-input'].value || '').trim();
            var idx = 0;
            for (var i = 0; i < samples.length; i++) {
                if (current === samples[i]) { idx = (i + 1) % samples.length; break; }
            }
            this.elements['translate-input'].value = samples[idx];
        },

        clearAll: function () {
            this.elements['translate-input'].value = '';
            this.hideError();
            this.clearOutput();
            this.lastResult = null;
            this.elements['translate-input'].focus();
        },

        showError: function (msg) {
            var el = this.elements['translate-error'];
            el.textContent = '⚠ ' + msg;
            el.classList.add('show');
            el.hidden = false;
        },

        hideError: function () {
            var el = this.elements['translate-error'];
            el.classList.remove('show');
            el.hidden = true;
        },

        copyResult: function () {
            if (!this.lastResults || this.lastResults.length === 0) return;
            var texts = [];
            for (var i = 0; i < this.lastResults.length; i++) {
                var r = this.lastResults[i];
                if (r.ok) {
                    texts.push(r.chinese);
                }
            }
            var text = texts.join('\n\n');
            if (!text) return;
            var self = this;
            function fallback() {
                try {
                    var ta = document.createElement('textarea');
                    ta.value = text;
                    ta.style.position = 'fixed';
                    ta.style.opacity = '0';
                    document.body.appendChild(ta);
                    ta.select();
                    document.execCommand('copy');
                    document.body.removeChild(ta);
                    self.flashCopy('已复制（兜底）');
                } catch (e) {
                    if (global.Logger) global.Logger.error('[translator] 复制失败', e && e.message);
                }
            }
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(text).then(function () {
                    self.flashCopy('已复制');
                }, function () {
                    fallback();
                });
            } else {
                fallback();
            }
        },

        exportWord: function () {
            if (!this.lastResults || this.lastResults.length === 0) return;
            var exportResults = [];
            for (var i = 0; i < this.lastResults.length; i++) {
                var r = this.lastResults[i];
                exportResults.push({
                    original: r.original || '',
                    chinese: r.ok ? r.chinese : '(翻译失败: ' + (r.error || '') + ')'
                });
            }
            exportToWord(exportResults);
        },

        flashCopy: function (msg) {
            var btn = this.elements['translate-copy'];
            var old = btn.textContent;
            btn.textContent = msg;
            setTimeout(function () { btn.textContent = old; }, 1200);
        },

        /* ----- 最近翻译（chrome.storage.local 优先；降级 localStorage） ----- */

        loadRecent: function () {
            try {
                if (global.chrome && chrome.storage && chrome.storage.local) {
                    return new Promise(function (resolve) {
                        chrome.storage.local.get(this.RECENT_KEY, function (data) {
                            resolve((data && data[this.RECENT_KEY]) || []);
                        }.bind(this));
                    }.bind(this));
                }
            } catch (e) { /* fall through */ }
            try {
                var raw = global.localStorage.getItem('met_tool:' + this.RECENT_KEY);
                return Promise.resolve(raw ? JSON.parse(raw) : []);
            } catch (e) {
                return Promise.resolve([]);
            }
        },

        saveRecent: function (list) {
            try {
                if (global.chrome && chrome.storage && chrome.storage.local) {
                    var obj = {}; obj[this.RECENT_KEY] = list;
                    chrome.storage.local.set(obj, function () { /* noop */ });
                }
            } catch (e) { /* fall through */ }
            try {
                global.localStorage.setItem('met_tool:' + this.RECENT_KEY, JSON.stringify(list));
            } catch (e) { /* ignore */ }
        },

        pushRecent: function (rawText, result) {
            var self = this;
            this.loadRecent().then(function (list) {
                // 解析出 ICAO 与机场中文名（来自 airports.js），便于卡片展示
                var icao = (result.parsed && (result.parsed.icao || (result.parsed.main && result.parsed.main.icao))) || '';
                var airportName = '';
                try {
                    if (icao && global.AirportTemplate && typeof global.AirportTemplate.getNameByIcao === 'function') {
                        airportName = global.AirportTemplate.getNameByIcao(icao) || '';
                    }
                } catch (e) { /* ignore */ }
                var entry = {
                    ts: new Date().toISOString(),
                    type: result.type,
                    icao: icao,
                    airportName: airportName,
                    raw: rawText,
                    chinese: result.chinese,
                    ok: result.ok
                };
                // 去重：相同原文不重复
                list = (list || []).filter(function (e) { return e.raw !== rawText; });
                list.unshift(entry);
                if (list.length > self.MAX_RECENT) list = list.slice(0, self.MAX_RECENT);
                self.saveRecent(list);
                self.renderRecent();
            });
        },

        renderRecent: function () {
            var self = this;
            this.loadRecent().then(function (list) {
                var el = self.elements;
                el['translate-recent-count'].textContent = String(list.length);
                el['translate-recent'].innerHTML = '';
                if (!list || list.length === 0) {
                    var empty = document.createElement('div');
                    empty.className = 'empty';
                    empty.id = 'translate-recent-empty';
                    empty.textContent = '暂无历史记录';
                    el['translate-recent'].appendChild(empty);
                    self.elements['translate-recent-empty'] = empty;
                    return;
                }
                // 倒序展示：最新在最上（list 已按时间倒序）
                list.forEach(function (entry, idx) {
                    var card = document.createElement('div');
                    card.className = 'translate-recent-card' + (entry.ok === false ? ' is-error' : '');
                    var time = entry.ts ? entry.ts.replace('T', ' ').substring(0, 19) : '';
                    var typeText = escapeHtml(entry.type || 'METAR');
                    var icaoText = escapeHtml(entry.icao || '—');
                    var airportText = entry.airportName ? escapeHtml(entry.airportName) : '';
                    var chineseText = escapeHtml(entry.chinese || '');
                    var snippet = escapeHtml((entry.raw || '').replace(/\s+/g, ' ').trim().substring(0, 80));
                    var airportLine = airportText
                        ? '<span class="tr-airport-name">' + airportText + '</span>'
                        : '';
                    var cardNum = String(list.length - idx).padStart(2, '0');
                    card.innerHTML =
                        '<div class="tr-card-head">' +
                            '<span class="tr-card-index">' + cardNum + '</span>' +
                            '<span class="tr-card-type">' + typeText + '</span>' +
                            '<span class="tr-card-icao">' + icaoText + '</span>' +
                            airportLine +
                        '</div>' +
                        '<div class="tr-card-time">' + escapeHtml(time) + '</div>' +
                        '<div class="tr-card-chinese">' + chineseText + '</div>' +
                        '<div class="tr-card-snippet" title="' + escapeHtml(entry.raw || '') + '">原文：' + snippet + '</div>' +
                        '<div class="tr-card-actions">' +
                            '<button type="button" class="btn ghost small">回填</button>' +
                        '</div>';
                    var btn = card.querySelector('button');
                    btn.addEventListener('click', function () {
                        self.elements['translate-input'].value = entry.raw;
                        self.elements['translate-input'].focus();
                    });
                    el['translate-recent'].appendChild(card);
                });
            });
        },

        clearRecent: function () {
            var self = this;
            this.saveRecent([]);
            this.renderRecent();
            if (global.Logger) global.Logger.info('[translator] 已清空最近翻译');
        }
    };

    function escapeHtml(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    global.WeatherTranslatorUI = UI;

    /* ============================================================
     * 自初始化（DOM 就绪时自动绑定 UI，与 app.js boot 解耦）
     * ============================================================ */
    function autoInit() {
        try {
            UI.init();
        } catch (e) {
            if (global.Logger) global.Logger.error('[translator] UI 初始化失败', e && e.message);
        }
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', autoInit);
    } else {
        // 延后一帧让 app.js 先执行
        setTimeout(autoInit, 0);
    }
})(window);

