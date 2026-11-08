/**
 * 從歷史配方聯合反推色料模型
 *
 * 很多工廠有幾十張既有配方紀錄（各色料用量 + 實測色），但沒人去打過
 * 單色濃度梯度。這個模組讓那些資料直接變成模型。
 *
 * 原理：彩色料假設只吸收不散射，所以在每個通道上
 *
 *     (K/S)_obs × S_mix − K_已知 = Σ_未知 c_i · k_i
 *
 * 右邊對未知的 k_i 是線性的。每張歷史配方給一條方程式，
 * 未知數是每支色料的 k（每通道一個），用非負最小二乘解。
 * 非負是物理約束：吸收不可能是負的。
 *
 * 最重要的不是解出來，而是知道「解不出來」：
 *  - 配方數少於未知色料數 → 欠定，無限多組解
 *  - 兩支色料在所有配方裡都以固定比例出現 → 共線，分不開誰是誰
 * 這兩種情況必須擋下來，不能硬給一組看起來很合理的數字。
 */

import { labToKS, S_RESIN } from './km.js';
import { FIT_FORM } from './km.js';

/** 判定共線的門檻：某欄被其他欄解釋掉後，殘餘比例低於此值就視為分不開 */
export const COLLINEAR_TOL = 0.08;

/* ------------------------------------------------------------------ *
 * 非負最小二乘（座標下降）
 * ------------------------------------------------------------------ */

/**
 * 解 min ||Ax − b||² s.t. x ≥ 0。
 * 問題規模小（未知數通常 < 15），座標下降簡單且穩定。
 */
export function nnls(A, b, { maxIter = 500, tol = 1e-10 } = {}) {
    const m = A.length;
    const n = m ? A[0].length : 0;
    const x = new Array(n).fill(0);
    if (!m || !n) return x;

    // 預先算各欄的平方和
    const colSq = new Array(n).fill(0);
    for (let j = 0; j < n; j++) {
        for (let i = 0; i < m; i++) colSq[j] += A[i][j] * A[i][j];
    }

    // 殘差 r = b − Ax
    const r = b.slice();

    for (let iter = 0; iter < maxIter; iter++) {
        let maxChange = 0;
        for (let j = 0; j < n; j++) {
            if (colSq[j] < 1e-14) continue;
            // 把第 j 欄的貢獻先加回殘差
            let dot = 0;
            for (let i = 0; i < m; i++) dot += A[i][j] * (r[i] + A[i][j] * x[j]);
            const next = Math.max(0, dot / colSq[j]);
            const delta = next - x[j];
            if (delta !== 0) {
                for (let i = 0; i < m; i++) r[i] -= A[i][j] * delta;
                x[j] = next;
                maxChange = Math.max(maxChange, Math.abs(delta));
            }
        }
        if (maxChange < tol) break;
    }
    return x;
}

/** 無約束最小二乘，僅用於共線診斷 */
function lstsqResidualNorm(A, b) {
    const m = A.length, n = m ? A[0].length : 0;
    if (!n) return norm(b);
    const x = new Array(n).fill(0);
    const r = b.slice();
    const colSq = new Array(n).fill(0);
    for (let j = 0; j < n; j++) for (let i = 0; i < m; i++) colSq[j] += A[i][j] * A[i][j];

    for (let iter = 0; iter < 400; iter++) {
        let maxChange = 0;
        for (let j = 0; j < n; j++) {
            if (colSq[j] < 1e-14) continue;
            let dot = 0;
            for (let i = 0; i < m; i++) dot += A[i][j] * (r[i] + A[i][j] * x[j]);
            const next = dot / colSq[j];
            const delta = next - x[j];
            if (delta !== 0) {
                for (let i = 0; i < m; i++) r[i] -= A[i][j] * delta;
                x[j] = next;
                maxChange = Math.max(maxChange, Math.abs(delta));
            }
        }
        if (maxChange < 1e-11) break;
    }
    return norm(r);
}

const norm = (v) => Math.sqrt(v.reduce((s, x) => s + x * x, 0));

/* ------------------------------------------------------------------ *
 * 可辨識性診斷
 * ------------------------------------------------------------------ */

/**
 * 檢查設計矩陣的每一欄能不能跟其他欄分開。
 * 作法：拿第 j 欄當目標，用其他欄去迴歸它。若殘餘很小，
 * 代表這支色料的用量總是跟別人連動，分不出各自的貢獻。
 *
 * @returns {Array<{index, usable, reason, residualRatio, appearances}>}
 */
export function diagnoseDesign(A, labels) {
    const m = A.length;
    const n = m ? A[0].length : 0;
    const out = [];

    for (let j = 0; j < n; j++) {
        const col = A.map((row) => row[j]);
        const appearances = col.filter((v) => v > 1e-9).length;
        const colNorm = norm(col);

        if (colNorm < 1e-9) {
            out.push({ index: j, label: labels[j], usable: false, appearances, residualRatio: 0,
                reason: '沒有任何一張歷史配方用到這支色料' });
            continue;
        }
        if (appearances < 2) {
            out.push({ index: j, label: labels[j], usable: false, appearances, residualRatio: 1,
                reason: `只出現在 ${appearances} 張配方裡，至少要 2 張才能分離它的貢獻` });
            continue;
        }
        if (n === 1) {
            out.push({ index: j, label: labels[j], usable: true, appearances, residualRatio: 1, reason: '' });
            continue;
        }

        const others = A.map((row) => row.filter((_, k) => k !== j));
        const residualRatio = lstsqResidualNorm(others, col) / colNorm;

        out.push({
            index: j, label: labels[j], appearances, residualRatio,
            usable: residualRatio >= COLLINEAR_TOL,
            reason: residualRatio >= COLLINEAR_TOL ? ''
                : '用量在所有配方裡都跟其他色料連動，無法分離各自的貢獻（建議補一張只改這支用量的配方）',
        });
    }
    return out;
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

/**
 * 以歷史配方聯合擬合未知色料的吸收係數。
 *
 * @param {object} p
 * @param {Array} p.samples  [{ id, measuredLab, items:[{colorantId, c, model?}] }]
 *                           model 已知的（有濃度曲線）會被當成已知項扣掉
 * @param {object} p.substrate
 * @param {string[]} p.unknownIds 要擬合的色料 id
 * @returns {{models:Object, diagnostics:Array, warnings:string[], rms:number[], sampleCount:number}}
 */
export function fitFromHistory({ samples, substrate, unknownIds }) {
    const warnings = [];
    const models = {};

    const usable = samples.filter((s) => s.measuredLab);
    if (!usable.length || !unknownIds.length) {
        return { models, diagnostics: [], warnings, rms: [0, 0, 0], sampleCount: 0 };
    }

    // 設計矩陣：每列一張配方，每欄一支未知色料，元素是有效濃度
    const A = usable.map((s) =>
        unknownIds.map((id) => {
            const it = s.items.find((x) => x.colorantId === id);
            return it ? it.c : 0;
        }));

    const diagnostics = diagnoseDesign(A, unknownIds);

    if (usable.length < unknownIds.length) {
        warnings.push(
            `歷史配方只有 ${usable.length} 張，要反推 ${unknownIds.length} 支色料的係數至少需要同樣張數，` +
            '目前是欠定的，結果僅供參考',
        );
    }

    // 每個通道各解一次
    const rms = [0, 0, 0];
    const kByColorant = unknownIds.map(() => [0, 0, 0]);

    for (let ch = 0; ch < 3; ch++) {
        const b = usable.map((s) => {
            const ks = labToKS(s.measuredLab)[ch];

            // 已知色料的貢獻先扣掉
            let Kknown = substrate.K[ch];
            let Smix = substrate.S[ch];
            for (const it of s.items) {
                if (!it.model || unknownIds.includes(it.colorantId)) continue;
                if (it.model.type === 'white') {
                    Kknown += it.c * it.model.k[ch];
                    Smix += it.c * it.model.s[ch];
                } else {
                    Kknown += it.model.kAt(it.c)[ch];
                }
            }
            return ks * Smix - Kknown;
        });

        const x = nnls(A, b);
        unknownIds.forEach((_, j) => { kByColorant[j][ch] = x[j]; });

        // 殘差
        const pred = A.map((row) => row.reduce((s, v, j) => s + v * x[j], 0));
        rms[ch] = Math.sqrt(b.reduce((s, v, i) => s + (v - pred[i]) ** 2, 0) / b.length);
    }

    // 組成與 fitColorant 相同形狀的模型，下游不必分辨來源
    unknownIds.forEach((id, j) => {
        const diag = diagnostics[j];
        if (!diag.usable) {
            warnings.push(`「${id}」無法由歷史配方反推：${diag.reason}`);
            return;
        }
        const k = kByColorant[j];
        if (k.every((v) => v < 1e-9)) {
            warnings.push(`「${id}」由歷史配方反推出的吸收係數為零，資料可能不足或互相矛盾`);
            return;
        }
        const col = A.map((row) => row[j]).filter((v) => v > 1e-9);
        models[id] = {
            type: 'chromatic',
            form: FIT_FORM.LINEAR,
            source: 'history',           // 下游用這個旗標降低信心分數
            channels: k.map((alpha) => ({
                form: FIT_FORM.LINEAR,
                eval: (c) => alpha * Math.max(c, 0),
                params: { alpha, gamma: 1 },
                r2: null,
            })),
            r2: [null, null, null],
            cRange: [Math.min(...col), Math.max(...col)],
            appearances: diag.appearances,
            kAt: (c) => k.map((alpha) => alpha * Math.max(c, 0)),
            sAt: () => [0, 0, 0],
        };
    });

    return { models, diagnostics, warnings, rms, sampleCount: usable.length };
}

export default { nnls, diagnoseDesign, fitFromHistory, COLLINEAR_TOL };
