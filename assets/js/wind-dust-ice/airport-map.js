/**
 * 机场名称与编码映射数据（用户可手动维护）
 * --------------------------------------------------------------------
 * 本文件集中存放「机场中文名 / ICAO 四字码 / IATA 三字码」之间的映射关系，
 * 供 airports.js 及其他模块统一读取。如需新增、改名或修正机场，只需修改本文件。
 *
 * 数据来源："#/C0039机场列表.xlsx"
 *   - 共 128 个机场（国内 100 + 国际/地区 28）
 *   - 字段：city（中文标准名）/ icao（4 字母 ICAO）/ iata（3 字母 IATA）
 *
 * 维护说明：
 *   - AIRPORT_LIST 为主表：标准中文名 → ICAO → IATA，自动生成"中文名→ICAO"映射
 *   - NAME_TO_ICAO 仅补充"别名"：不在主表中的其他中文叫法（如"海拉尔=ZBLA"="呼伦贝尔"）
 *   - 修改后刷新页面即可生效，无需改动逻辑代码
 */
(function (global) {
    'use strict';

    /* ============================================================
     * 机场全量列表（含 IATA）
     * 联想/识别模块专用：按 city 精确匹配去重，优先返回序号靠前的标准名
     * ============================================================ */
    var AIRPORT_LIST = [
        // ====== 国内 ZB 北方区 ======
        { city: '秦皇岛', icao: 'ZBDH', iata: 'BPE' },
        { city: '大同', icao: 'ZBDT', iata: 'DAT' },
        { city: '呼和浩特', icao: 'ZBHH', iata: 'HET' },
        { city: '霍林河', icao: 'ZBHZ', iata: 'HUO' },
        { city: '海拉尔', icao: 'ZBLA', iata: 'HLD' },
        { city: '满洲里', icao: 'ZBMZ', iata: 'NZH' },
        { city: '包头', icao: 'ZBOW', iata: 'BAV' },
        { city: '石家庄', icao: 'ZBSJ', iata: 'SJW' },
        { city: '唐山', icao: 'ZBSN', iata: 'TVS' },
        { city: '天津', icao: 'ZBTJ', iata: 'TSN' },
        { city: '通辽', icao: 'ZBTL', iata: 'TGO' },
        { city: '忻州', icao: 'ZBXZ', iata: 'WUT' },
        { city: '太原', icao: 'ZBYN', iata: 'TYN' },
        // ====== ZG 华南区 ======
        { city: '北海', icao: 'ZGBH', iata: 'BHY' },
        { city: '广州', icao: 'ZGGG', iata: 'CAN' },
        { city: '长沙', icao: 'ZGHA', iata: 'CSX' },
        { city: '桂林', icao: 'ZGKL', iata: 'KWL' },
        { city: '南宁', icao: 'ZGNN', iata: 'NNG' },
        { city: '揭阳', icao: 'ZGOW', iata: 'SWA' },
        { city: '珠海', icao: 'ZGSD', iata: 'ZUH' },
        { city: '深圳', icao: 'ZGSZ', iata: 'SZX' },
        { city: '郑州', icao: 'ZHCC', iata: 'CGO' },
        { city: '鄂州', icao: 'ZHEC', iata: 'EHU' },
        { city: '恩施', icao: 'ZHES', iata: 'ENH' },
        { city: '武汉', icao: 'ZHHH', iata: 'WUH' },
        { city: '荆州', icao: 'ZHJZ', iata: 'SHS' },
        { city: '洛阳', icao: 'ZHLY', iata: 'LYA' },
        { city: '南阳', icao: 'ZHNY', iata: 'NNY' },
        { city: '襄阳', icao: 'ZHXF', iata: 'XFN' },
        { city: '宜昌', icao: 'ZHYC', iata: 'YIH' },
        { city: '海口', icao: 'ZJHK', iata: 'HAK' },
        { city: '琼海', icao: 'ZJQH', iata: 'BAR' },
        { city: '三亚', icao: 'ZJSY', iata: 'SYX' },
        { city: '郴州', icao: 'ZGCZ', iata: 'HCZ' },
        { city: '惠州', icao: 'ZGHZ', iata: 'HUZ' },
        { city: '湘西', icao: 'ZGXX', iata: 'DXJ' },
        { city: '湛江', icao: 'ZGZJ', iata: 'ZHA' },
        { city: '安阳', icao: 'ZHQQ', iata: 'HQQ' },
        // ====== ZL 西北区 ======
        { city: '敦煌', icao: 'ZLDH', iata: 'DNH' },
        { city: '银川', icao: 'ZLIC', iata: 'INC' },
        { city: '嘉峪关', icao: 'ZLJQ', iata: 'JGN' },
        { city: '兰州', icao: 'ZLLL', iata: 'LHW' },
        { city: '庆阳', icao: 'ZLQY', iata: 'IQN' },
        { city: '西宁', icao: 'ZLXN', iata: 'XNN' },
        { city: '西安', icao: 'ZLXY', iata: 'XIY' },
        { city: '榆林', icao: 'ZLYL', iata: 'UYN' },
        { city: '中卫', icao: 'ZLZW', iata: 'ZHY' },
        // ====== ZP 西南区 ======
        { city: '西双版纳', icao: 'ZPJH', iata: 'JHG' },
        { city: '丽江', icao: 'ZPLJ', iata: 'LJG' },
        { city: '芒市', icao: 'ZPMS', iata: 'LUM' },
        { city: '昆明', icao: 'ZPPP', iata: 'KMG' },
        { city: '腾冲', icao: 'ZPTC', iata: 'TCZ' },
        { city: '文山', icao: 'ZPWS', iata: 'WNH' },
        { city: '昭通', icao: 'ZPZT', iata: 'ZAT' },
        // ====== ZS 华东区 ======
        { city: '厦门', icao: 'ZSAM', iata: 'XMN' },
        { city: '常州', icao: 'ZSCG', iata: 'CZX' },
        { city: '南昌', icao: 'ZSCN', iata: 'KHN' },
        { city: '福州', icao: 'ZSFZ', iata: 'FOC' },
        { city: '杭州', icao: 'ZSHC', iata: 'HGH' },
        { city: '济南', icao: 'ZSJN', iata: 'TNA' },
        { city: '济宁', icao: 'ZSJG', iata: 'JNG' },
        { city: '连云港', icao: 'ZSLG', iata: 'LYG' },
        { city: '宁波', icao: 'ZSNB', iata: 'NGB' },
        { city: '南京', icao: 'ZSNJ', iata: 'NKG' },
        { city: '南通', icao: 'ZSNT', iata: 'NTG' },
        { city: '合肥', icao: 'ZSOF', iata: 'HFE' },
        { city: '青岛', icao: 'ZSQD', iata: 'TAO' },
        { city: '泉州', icao: 'ZSQZ', iata: 'JJN' },
        { city: '芜湖', icao: 'ZSWA', iata: 'WHA' },
        { city: '潍坊', icao: 'ZSWF', iata: 'WEF' },
        { city: '威海', icao: 'ZSWH', iata: 'WEH' },
        { city: '无锡', icao: 'ZSWX', iata: 'WUX' },
        { city: '温州', icao: 'ZSWZ', iata: 'WNZ' },
        { city: '徐州', icao: 'ZSXZ', iata: 'XUZ' },
        { city: '扬州', icao: 'ZSYA', iata: 'YTY' },
        { city: '烟台', icao: 'ZSYT', iata: 'YNT' },
        { city: '盐城', icao: 'ZSYN', iata: 'YNZ' },
        { city: '舟山', icao: 'ZSZS', iata: 'HSN' },
        // ====== ZU 华中区 ======
        { city: '巴中', icao: 'ZUBZ', iata: 'BZX' },
        { city: '重庆', icao: 'ZUCK', iata: 'CKG' },
        { city: '贵阳', icao: 'ZUGY', iata: 'KWE' },
        { city: '绵阳', icao: 'ZUMY', iata: 'MIG' },
        { city: '天府', icao: 'ZUTF', iata: 'TFU' },
        { city: '铜仁', icao: 'ZUTR', iata: 'TEN' },
        { city: '万州', icao: 'ZUWX', iata: 'WXN' },
        { city: '遵义', icao: 'ZUZY', iata: 'ZYI' },
        { city: '双流', icao: 'ZUUU', iata: 'CTU' },
        // ====== ZW 新疆区 ======
        { city: '哈密', icao: 'ZWHM', iata: 'HMI' },
        { city: '库尔勒', icao: 'ZWKL', iata: 'KRL' },
        { city: '克拉玛依', icao: 'ZWKM', iata: 'KRY' },
        { city: '喀什', icao: 'ZWSH', iata: 'KHG' },
        { city: '吐鲁番', icao: 'ZWTL', iata: 'TLQ' },
        { city: '和田', icao: 'ZWTN', iata: 'HTN' },
        { city: '乌鲁木齐', icao: 'ZWWW', iata: 'URC' },
        // ====== ZY 东北区 ======
        { city: '长春', icao: 'ZYCC', iata: 'CGQ' },
        { city: '哈尔滨', icao: 'ZYHB', iata: 'HRB' },
        { city: '大连', icao: 'ZYTL', iata: 'DLC' },
        { city: '沈阳', icao: 'ZYTX', iata: 'SHE' },
        { city: '锦州', icao: 'ZYJZ', iata: 'JNZ' },
        { city: '延吉', icao: 'ZYYJ', iata: 'YNJ' },
        // ====== VV 越南 ======
        { city: '海防', icao: 'VVCI', iata: 'HPH' },
        { city: '胡志明', icao: 'VVTS', iata: 'SGN' },
        { city: '芹苴', icao: 'VVCT', iata: 'VCA' },
        { city: '岘港', icao: 'VVDN', iata: 'DAD' },
        { city: '河内', icao: 'VVNB', iata: 'HAN' },
        { city: '顺化', icao: 'VVPB', iata: 'HUI' },
        { city: '富国岛', icao: 'VVPQ', iata: 'PQC' },
        // ====== VT 泰国 ======
        { city: '曼谷', icao: 'VTBD', iata: 'DMK' },
        { city: '曼谷素万那普', icao: 'VTBS', iata: 'BKK' },
        { city: '清迈', icao: 'VTCC', iata: 'CNX' },
        { city: '清莱', icao: 'VTCT', iata: 'CEI' },
        // ====== VY 缅甸 ======
        { city: '曼德勒', icao: 'VYMD', iata: 'MDL' },
        { city: '内比都', icao: 'VYNT', iata: 'NYT' },
        { city: '仰光', icao: 'VYYY', iata: 'RGN' },
        // ====== RK 韩国 ======
        { city: '光州', icao: 'RKJB', iata: 'MWX' },
        { city: '首尔', icao: 'RKSI', iata: 'ICN' },
        { city: '大邱', icao: 'RKTN', iata: 'TAE' },
        { city: '清州', icao: 'RKTU', iata: 'CJJ' },
        // ====== RJ 日本 ======
        { city: '东京成田', icao: 'RJAA', iata: 'NRT' },
        { city: '大阪', icao: 'RJBB', iata: 'KIX' },
        { city: '福冈', icao: 'RJFF', iata: 'FUK' },
        { city: '大分', icao: 'RJFO', iata: 'OIT' },
        { city: '名古屋', icao: 'RJGG', iata: 'NGO' },
        { city: '东京羽田', icao: 'RJTT', iata: 'HND' },
        // ====== VD 柬埔寨 ======
        { city: '暹粒', icao: 'VDSA', iata: 'SAI' },
        { city: '西哈努克', icao: 'VDSV', iata: 'KOS' },
        { city: '德崇', icao: 'VDTI', iata: 'KTI' },
        // ====== VL 老挝 ======
        { city: '万象', icao: 'VLVT', iata: 'VTE' }
    ];

    /* ============================================================
     * 中文名 → ICAO 编码（仅存放"别名"）
     * 标准中文名已在 AIRPORT_LIST 中定义，会自动生成映射；
     * 此处仅补充主表之外的其他中文叫法，指向同一 ICAO，主要为了解决用户输入和航班动态查询时的不一致问题
     * 例如：动态表格里边使用的是"呼伦贝尔"，用户输入时可能会使用"海拉尔"，导致查询结果不一致
     * ============================================================ */
    var NAME_TO_ICAO = {
        '呼伦贝尔': 'ZBLA',   // 模板别名：C0039 标准名"呼伦贝尔"
        '霍林郭勒': 'ZBHZ', // 航班文件别名：全称，与"霍林河"同 ICAO
        '呼和': 'ZBHH',     // 航班文件别名：简称，与"呼和浩特"同 ICAO
        '芒市': 'ZPMS',     // 模板别名：C0039 标准名"德宏"
        '成都': 'ZUTF',     // 模板/C0039 别名：标准名"成都"
        '胡志明': 'VVTS',   // 模板别名：C0039 标准名"胡志明市"
        '东京': 'RJAA',      // 通用别名：标准名"东京成田"
        '德宏': 'ZPMS',      // 通用别名：标准名"德宏"
        // 以下为大风沙尘结冰通报模板专用别名（模板中文名与 C0039 标准名不一致时使用）
        '五台山': 'ZBXZ',   // 模板中文名"五台山"对应 ICAO ZBXZ（C0039 标准名"忻州"）
        '成都天府': 'ZUTF'  // 模板中文名"成都天府"对应 ICAO ZUTF（C0039 标准名"天府"）
    };

    /* ============================================================
     * ICAO → 跑道号 映射
     * 数据来源："#/C0039机场列表.xlsx" 的「跑道号」列
     * 多跑道时用中文顿号「、」分隔（如昆明 03/21、04L/22R、04R/22L）
     * 供气象简报机场预警截图在天气类型含 顺风/侧风/大风 时，于机场名下方展示
     * ============================================================ */
    var RUNWAY_BY_ICAO = {
        // ====== ZB 北方区 ======
        'ZBDH': '08/26', 'ZBDT': '14/32', 'ZBHH': '08/26', 'ZBHZ': '11/29',
        'ZBLA': '09/27', 'ZBMZ': '12/30', 'ZBOW': '13/31', 'ZBSJ': '15/33',
        'ZBSN': '10/28', 'ZBTJ': '16L/34R、16R/34L', 'ZBTL': '02/20',
        'ZBXZ': '08/26', 'ZBYN': '13L/31R、13R/31L',
        // ====== ZG/ZH 华南区 ======
        'ZGBH': '01/19', 'ZGGG': '01L/19R、01R/19L、02L/20R、02R/20L、03/21',
        'ZGHA': '18L/36R、18R/36L', 'ZGKL': '01/19', 'ZGNN': '04/22、05/23',
        'ZGOW': '04/22', 'ZGSD': '05/23', 'ZGSZ': '15/33、16L/34R、16R/34L',
        'ZHCC': '12L/30R、12R/30L', 'ZHEC': '01L/19R、01R/19L', 'ZHES': '01/19',
        'ZHHH': '04/22、05L/23R、05R/23L', 'ZHJZ': '01/19', 'ZHLY': '08/26',
        'ZHNY': '05/23', 'ZHXF': '01/19', 'ZHYC': '14/32',
        'ZJHK': '09/27、10/28', 'ZJQH': '15/33', 'ZJSY': '08/26',
        'ZGCZ': '07/25', 'ZGHZ': '09/27', 'ZGXX': '04/22', 'ZGZJ': '15/33', 'ZHQQ': '03/21',
        // ====== ZL 西北区 ======
        'ZLDH': '08/26', 'ZLIC': '03/21', 'ZLJQ': '14/32', 'ZLLL': '01/19',
        'ZLQY': '14/32', 'ZLXN': '11/29', 'ZLXY': '05L/23R、06L/24R、06R/24L',
        'ZLYL': '16/34', 'ZLZW': '09/27',
        // ====== ZP 西南区 ======
        'ZPJH': '16/34', 'ZPLJ': '02/20', 'ZPMS': '05/23',
        'ZPPP': '03/21、04L/22R、04R/22L', 'ZPTC': '18/36', 'ZPWS': '02/20', 'ZPZT': '04/22',
        // ====== ZS 华东区 ======
        'ZSAM': '05/23', 'ZSCG': '11/29', 'ZSCN': '03/21', 'ZSFZ': '03/21',
        'ZSHC': '06/24、07/25', 'ZSJN': '01/19', 'ZSJG': '09/27', 'ZSLG': '03/21',
        'ZSNB': '13/31', 'ZSNJ': '06/24、07/25', 'ZSNT': '18/36', 'ZSOF': '15/33',
        'ZSQD': '16/34、17/35', 'ZSQZ': '03/21', 'ZSWA': '06/24', 'ZSWF': '17/35',
        'ZSWX': '03/21', 'ZSWZ': '03/21', 'ZSWH': '03/21', 'ZSXZ': '09/27',
        'ZSYA': '17/35', 'ZSYN': '04/22', 'ZSYT': '05/23', 'ZSZS': '18/36',
        // ====== ZU 华中区 ======
        'ZUBZ': '07/25', 'ZUCK': '02L/20R、02R/20L、03L/21R、03R/21L',
        'ZUGY': '01L/19R、01R/19L', 'ZUMY': '14/32', 'ZUTF': '01/19、02/20',
        'ZUTR': '04/22', 'ZUWX': '11/29', 'ZUZY': '18/36', 'ZUUU': '02L/20R、02R/20L',
        // ====== ZW 新疆区 ======
        'ZWHM': '11/29', 'ZWKL': '04/22', 'ZWKM': '13/31', 'ZWSH': '08/26',
        'ZWTL': '09/27', 'ZWTN': '11L/29R、11R/29L', 'ZWWW': '08L/26R、08R/26L',
        // ====== ZY 东北区 ======
        'ZYCC': '06/24', 'ZYHB': '05L/23R、05R/23L', 'ZYTL': '10/28', 'ZYTX': '06/24',
        'ZYJZ': '04/22', 'ZYYJ': '09/27',
        // ====== VV 越南 ======
        'VVCI': '07/25', 'VVTS': '07L/25R、07R/25L', 'VVCT': '06/24',
        'VVDN': '17L/35R、17R/35L', 'VVNB': '11L/29R、11R/29L', 'VVPB': '09/27',
        'VVPQ': '10/28',
        // ====== VT 泰国 ======
        'VTBD': '03L/21R、03R/21L', 'VTBS': '01/19、02L/20R、02R/20L',
        'VTCC': '18/36', 'VTCT': '03/21',
        // ====== VY 缅甸 ======
        'VYMD': '17/35', 'VYNT': '16/34', 'VYYY': '03/21',
        // ====== RK 韩国 ======
        'RKJB': '01/19', 'RKSI': '15L/33R、15R/33L、16L/34R、16R/34L',
        'RKTN': '13L/31R、13R/31L', 'RKTU': '06L/24R、06R/24L',
        // ====== RJ 日本 ======
        'RJAA': '16L/34R、16R/34L', 'RJBB': '06L/24R、06R/24L',
        'RJFF': '16L/34R、16R/34L', 'RJFO': '01/19', 'RJGG': '18/36',
        'RJTT': '04/22、05/23、16R/34L、16L/34R',
        // ====== VD 柬埔寨 / VL 老挝 ======
        'VDSA': '05/23', 'VDSV': '03/21', 'VDTI': '05/23', 'VLVT': '13/31'
    };

    /* 暴露给全局，供 airports.js 及逻辑模块读取 */
    global.AirportMap = {
        list: AIRPORT_LIST,       // 全量列表（city / icao / iata）
        nameToIcao: NAME_TO_ICAO, // 中文名（含别名）→ ICAO
        runwayByIcao: RUNWAY_BY_ICAO // ICAO → 跑道号（多跑道用「、」分隔）
    };
})(window);