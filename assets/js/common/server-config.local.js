/**
 * 服务端对接本地配置（不入版本库）
 * --------------------------------------------------------------------
 * 本文件已被 .gitignore 的 *.local.js 规则忽略，请勿提交到仓库。
 *
 * 若本文件缺失或字段为空，预警上报功能会自动降级为「不上报」，
 * 一键截图、历史预警记录、导出 Excel 等既有功能不受任何影响。
 *
 * 字段说明：
 *   baseUrl  自建服务器地址（DSP 数据填写网站服务，公网 47.108.164.58:3000）
 *   apiKey   预警上报专用密钥，必须与服务端 /opt/dsp-site/.env 中的
 *            DSP_WARNING_API_KEY 完全一致
 */
window.MeteoServerConfig = {
    baseUrl: 'http://47.108.164.58:3000',
    apiKey: 'fe1fcc9fa64b2e08edb41b0eab57b39a50f8e9ce1808ec6fbac6e162d686442e'
};