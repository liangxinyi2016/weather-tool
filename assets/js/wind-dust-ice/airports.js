/**
 * 大风/沙尘/结冰通报模板 & 机场工具函数
 * --------------------------------------------------------------------
 * - 机场名称/ICAO/IATA 映射数据已独立到 airport-map.js（全局 AirportMap），
 *   本文件仅保留模板顺序与逻辑函数，实现"数据与逻辑分离"。
 * 模板顺序数据来源：用户指定 ICAO 四字码序列
 *                     共 63 个机场。
 *
 * 维护说明：
 *   - 新增/修正机场：修改 airport-map.js（全局 AirportMap），无需改动本文件
 *   - 模板中已硬编码的 63 个机场顺序不可调整，否则会破坏通报布局
 */
(function (global) {
    'use strict';

    /* ============================================================
     * 依赖 airport-map.js 提供的映射数据（StandardName→ICAO / 别名）
     * ============================================================ */
    var AIRPORT_LIST = (global.AirportMap && global.AirportMap.list) || [];

    /* 由主表生成"标准中文名→ICAO"，再叠加 airport-map.js 中的别名 */
    var NAME_TO_ICAO = {};
    for (var _i = 0; _i < AIRPORT_LIST.length; _i++) {
        NAME_TO_ICAO[AIRPORT_LIST[_i].city] = AIRPORT_LIST[_i].icao;
    }
    if (global.AirportMap && global.AirportMap.nameToIcao) {
        for (var _alias in global.AirportMap.nameToIcao) {
            if (Object.prototype.hasOwnProperty.call(global.AirportMap.nameToIcao, _alias)) {
                NAME_TO_ICAO[_alias] = global.AirportMap.nameToIcao[_alias];
            }
        }
    }

    /* ============================================================
     * 大风沙尘结冰通报模板机场顺序（63 个，按 ICAO 四字码排序）
     * 顺序来源：用户指定 ICAO 序列，与模板布局严格一致
     * ============================================================ */
    var TEMPLATE_AIRPORTS = [
        '沈阳', '哈尔滨', '长春', '延吉', '大连', '呼和浩特', '包头', '霍林河',
        '海拉尔', '天津', '石家庄', '大同', '五台山', '太原', '济南', '青岛',
        '烟台', '威海', '常州', '合肥', '南通', '盐城', '无锡', '杭州', '温州',
        '宁波', '福州', '厦门', '泉州', '南昌', '武汉', '恩施', '郑州', '安阳',
        '南阳', '深圳', '珠海', '揭阳', '南宁', '惠州', '长沙', '郴州', '湘西',
        '湛江', '重庆', '贵阳', '成都天府', '西双版纳', '丽江', '芒市', '昆明',
        '西宁', '兰州', '嘉峪关', '西安', '银川', '吐鲁番', '胡志明', '海防',
        '曼德勒', '西哈努克', '富国岛', '清州'
    ];

    /* ============================================================
     * 工具函数
     * ============================================================ */

    /**
     * 根据 ICAO 编码在模板中查找行索引（0-based）；找不到则返回 -1
     * @param {string} icao
     * @returns {number}
     */
    function findIndexByIcao(icao) {
        if (!icao) return -1;
        var code = String(icao).toUpperCase();
        // 反查 NAME_TO_ICAO，找到该 ICAO 对应的所有中文名
        for (var name in NAME_TO_ICAO) {
            if (Object.prototype.hasOwnProperty.call(NAME_TO_ICAO, name) &&
                NAME_TO_ICAO[name] === code) {
                var idx = TEMPLATE_AIRPORTS.indexOf(name);
                if (idx >= 0) return idx;
            }
        }
        return -1;
    }

    /**
     * 根据 ICAO 编码取首选中文名（用于在追加行中显示机场名）
     * 优先返回 C0039 中的标准名（不带"别名"标识）
     * @param {string} icao
     * @returns {string}
     */
    function getNameByIcao(icao) {
        if (!icao) return '';
        var code = String(icao).toUpperCase();
        // 优先级：模板名 > C0039 标准名 > 第一个匹配
        for (var i = 0; i < TEMPLATE_AIRPORTS.length; i++) {
            if (NAME_TO_ICAO[TEMPLATE_AIRPORTS[i]] === code) return TEMPLATE_AIRPORTS[i];
        }
        // 模板中没有，返回 C0039 中的第一个匹配
        for (var name in NAME_TO_ICAO) {
            if (Object.prototype.hasOwnProperty.call(NAME_TO_ICAO, name) &&
                NAME_TO_ICAO[name] === code) return name;
        }
        return code;
    }

    /**
     * 判断 ICAO 是否在国内（用于日志/UI 提示）
     * @param {string} icao
     * @returns {boolean}
     */
    function isDomestic(icao) {
        if (!icao) return false;
        return /^Z[A-Z]/.test(String(icao).toUpperCase());
    }

    /**
     * 翻译模块专用：返回「中文名 ICAO」或仅 ICAO（未命中时）
     * @param {string} icao
     * @returns {string}
     */
    function getAirportName(icao) {
        if (!icao) return '';
        var code = String(icao).toUpperCase();
        var name = getNameByIcao(code);
        if (name && name !== code) return name + ' ' + code;
        return code;
    }

    /**
     * 联想匹配：按 city/icao/iata 任一字段不区分大小写包含 query
     * 排序：精确匹配（忽略大小写） > 前缀匹配 > 包含匹配；同优先级按 Excel 序号
     * @param {string} query 用户输入
     * @param {number} limit 最大返回数（默认 10）
     * @returns {Array<{city:string, icao:string, iata:string}>}
     */
    function getAutocompleteMatches(query, limit) {
        if (!query) return [];
        var q = String(query).trim();
        if (!q) return [];
        var qLower = q.toLowerCase();
        var qUpper = q.toUpperCase();

        var exact = [];     // 精确匹配（city/icao/iata 任一字段完全等于 query）
        var prefix = [];    // 前缀匹配
        var contains = [];  // 包含匹配

        for (var i = 0; i < AIRPORT_LIST.length; i++) {
            var item = AIRPORT_LIST[i];
            var city = item.city || '';
            var icao = item.icao || '';
            var iata = item.iata || '';
            var cityLower = city.toLowerCase();
            var icaoLower = icao.toLowerCase();
            var iataLower = iata.toLowerCase();

            // 精确匹配（忽略大小写）
            if (cityLower === qLower || icaoLower === qLower || iataLower === qLower ||
                icao === qUpper || iata === qUpper) {
                exact.push(item);
                continue;
            }
            // 前缀匹配
            if (cityLower.indexOf(qLower) === 0 || icaoLower.indexOf(qLower) === 0 || iataLower.indexOf(qLower) === 0) {
                prefix.push(item);
                continue;
            }
            // 包含匹配
            if (cityLower.indexOf(qLower) >= 0 || icaoLower.indexOf(qLower) >= 0 || iataLower.indexOf(qLower) >= 0) {
                contains.push(item);
            }
        }

        var combined = exact.concat(prefix).concat(contains);
        var max = (typeof limit === 'number' && limit > 0) ? limit : 10;
        return combined.slice(0, max);
    }

    /**
     * 机场名规范化：从任意形态（city/icao/iata）还原为标准 city
     * - 精确 city → 原 city
     * - 精确 ICAO（不区分大小写） → 第一个匹配的 city
     * - 精确 IATA（不区分大小写） → 第一个匹配的 city
     * - 模板别名（如"成都天府"=ZUTF）也支持反向解析
     * - 无法识别 → 原样返回（保留用户输入）
     * @param {string} input
     * @returns {string}
     */
    function resolveAirport(input) {
        if (input == null) return '';
        var raw = String(input).trim();
        if (!raw) return '';
        var rawUpper = raw.toUpperCase();

        // 1) 精确 city 匹配（包含模板别名）
        for (var i = 0; i < AIRPORT_LIST.length; i++) {
            if (AIRPORT_LIST[i].city === raw) return raw;
        }
        // 模板别名通过 NAME_TO_ICAO 也能命中 → 转 ICAO 后再查
        if (NAME_TO_ICAO[raw]) {
            var aliasIcao = NAME_TO_ICAO[raw];
            for (var j = 0; j < AIRPORT_LIST.length; j++) {
                if (AIRPORT_LIST[j].icao === aliasIcao) return AIRPORT_LIST[j].city;
            }
        }

        // 2) 精确 ICAO 匹配
        for (var k = 0; k < AIRPORT_LIST.length; k++) {
            if (AIRPORT_LIST[k].icao && AIRPORT_LIST[k].icao.toUpperCase() === rawUpper) {
                return AIRPORT_LIST[k].city;
            }
        }

        // 3) 精确 IATA 匹配
        for (var m = 0; m < AIRPORT_LIST.length; m++) {
            if (AIRPORT_LIST[m].iata && AIRPORT_LIST[m].iata.toUpperCase() === rawUpper) {
                return AIRPORT_LIST[m].city;
            }
        }

        // 4) 大小写不敏感 city 匹配
        for (var n = 0; n < AIRPORT_LIST.length; n++) {
            if (AIRPORT_LIST[n].city && AIRPORT_LIST[n].city.toLowerCase() === raw.toLowerCase()) {
                return AIRPORT_LIST[n].city;
            }
        }

        // 5) 无法识别：原样返回
        return raw;
    }

    global.AirportTemplate = {
        airports: TEMPLATE_AIRPORTS,
        airportList: AIRPORT_LIST,
        nameToIcao: NAME_TO_ICAO,
        findIndexByIcao: findIndexByIcao,
        getNameByIcao: getNameByIcao,
        getAirportName: getAirportName,
        isDomestic: isDomestic,
        getAutocompleteMatches: getAutocompleteMatches,
        resolveAirport: resolveAirport
    };
})(window);
