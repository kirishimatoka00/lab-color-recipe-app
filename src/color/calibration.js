/**
 * 歷史配方校正層
 *
 * 純物理模型（km.js）永遠對不準實際生產，原因是分散度、批次色力差異、
 * 射出條件、量測幾何等等。歷史配方的價值在於把這些系統誤差吃掉。
 *
 * 三層，由強到弱依序套用：
 *
 *  1. 色力係數 strength：每支色料一個純量，乘在它的吸收貢獻上。
 *     用所有歷史配方做最小二乘擬合。這層處理「這批紅比標準紅弱 8%」這類
 *     全域性的偏差，物理意義明確，外插時仍然可信。
 *
 *  2. 殘差場 residual field：套完色力後仍有的 ΔLab，依與歷史配方的距離做
 *     高斯加權內插，疊加到預測上。這層處理模型形式本身的不足，
 *     只在歷史配方附近可信，離得遠權重自然衰減到 0。
 *
 *  3. 信心分數 confidence：把「這個預測有多可信」量化，讓使用者知道
 *     什麼時候該直接打樣、什麼時候只是參考。
 *
 * 分群：只有「同基礎樹酯 + 同載體 + 同量測條件」的歷史配方才進同一個校正集。
 * 使用者的設定是「顏色預判基於相同母粒載體」，這裡就是落實的地方。
 */

import { mixToLab } from './km.js';
import { deltaE00, deltaE76 } from './colorUtils.js';
import { nelderMead } from './solver.js';

/** 色力係數的容許範圍。超出這個範圍代表資料有問題，不該讓它硬湊。 */
export const STRENGTH_BOUNDS = [0.6, 1.6];

/** 殘差場的高斯頻寬（Lab 空間距離，單位 ΔE）。 */
export const RESIDUAL_BANDWIDTH = 12;

/**
 * 校正集的分群 key。
 * @param {object} f 配方
 */
export const calibrationKey = (f) =>
    [f.baseResinId || '-', f.carrierId || '-', (f.condition || '').trim()].join('|');

/**
 * 從歷史配方擬合色力係數。
 *
 * @param {Array} samples [{ items:[{colorantId, model, c}], measuredLab }]
 * @param {object} substrate
 * @param {object} opts
 * @returns {{strengths:Object<string,number>, before:object, after:object, used:string[]}}
 */
export function fitStrengths(samples, substrate, opts = {}) {
    const minAppearances = opts.minAppearances ?? 2;

    // 只校正出現次數足夠的色料，否則一支只出現一次的色料會把自己的殘差全吃掉
    const count = {};
    for (const s of samples) {
        for (const it of s.items) if (it.c > 0) count[it.colorantId] = (count[it.colorantId] || 0) + 1;
    }
    const ids = Object.keys(count).filter((id) => count[id] >= minAppearances);

    const scoreWith = (strengths) => {
        let sum = 0;
        for (const s of samples) {
            const items = s.items.map((it) => ({
                model: it.model, c: it.c, strength: strengths[it.colorantId] ?? 1,
            })).filter((it) => it.c > 0);
            sum += deltaE00(mixToLab(items, substrate).lab, s.measuredLab) ** 2;
        }
        return Math.sqrt(sum / Math.max(1, samples.length));
    };

    const before = evaluate(samples, substrate, {});
    if (!ids.length || samples.length < 2) {
        return { strengths: {}, before, after: before, used: [] };
    }

    const toMap = (x) => Object.fromEntries(ids.map((id, i) => [id, x[i]]));
    const r = nelderMead(
        (x) => scoreWith(toMap(x)),
        ids.map(() => 1),
        ids.map(() => STRENGTH_BOUNDS[0]),
        ids.map(() => STRENGTH_BOUNDS[1]),
        { tol: 1e-6, step: ids.map(() => 0.08) },
    );

    const strengths = toMap(r.x);
    const after = evaluate(samples, substrate, strengths);

    // 校正後反而變差就不要用。這種情況通常代表歷史資料互相矛盾。
    if (after.rmsDE00 >= before.rmsDE00) {
        return { strengths: {}, before, after: before, used: [], rejected: true };
    }
    return { strengths, before, after, used: ids };
}

/** 用給定的色力係數評估一組樣本的預測誤差 */
export function evaluate(samples, substrate, strengths = {}) {
    const errs = samples.map((s) => {
        const items = s.items.map((it) => ({
            model: it.model, c: it.c, strength: strengths[it.colorantId] ?? 1,
        })).filter((it) => it.c > 0);
        const lab = mixToLab(items, substrate).lab;
        return {
            id: s.id, predicted: lab, measured: s.measuredLab,
            dE00: deltaE00(lab, s.measuredLab),
            dE76: deltaE76(lab, s.measuredLab),
            residual: {
                l: s.measuredLab.l - lab.l,
                a: s.measuredLab.a - lab.a,
                b: s.measuredLab.b - lab.b,
            },
        };
    });
    const n = Math.max(1, errs.length);
    return {
        perSample: errs,
        rmsDE00: Math.sqrt(errs.reduce((s, e) => s + e.dE00 ** 2, 0) / n),
        maxDE00: errs.reduce((m, e) => Math.max(m, e.dE00), 0),
        meanDE00: errs.reduce((s, e) => s + e.dE00, 0) / n,
        n: errs.length,
    };
}

/**
 * 建立殘差場。以「套完色力後的預測 Lab」為座標，存下殘差向量。
 */
export function buildResidualField(evaluation, bandwidth = RESIDUAL_BANDWIDTH) {
    return {
        bandwidth,
        nodes: evaluation.perSample.map((e) => ({
            at: e.predicted, residual: e.residual, id: e.id, dE00: e.dE00,
        })),
    };
}

/**
 * 對一個新預測套用殘差場修正。
 * @returns {{lab, applied:{l,a,b}, weight:number, nearest:{id, distance}|null}}
 */
export function applyResidualField(lab, field) {
    if (!field || !field.nodes.length) {
        return { lab, applied: { l: 0, a: 0, b: 0 }, weight: 0, nearest: null };
    }
    const h = field.bandwidth;
    let wSum = 0, rl = 0, ra = 0, rb = 0;
    let nearest = null;

    for (const node of field.nodes) {
        const d = deltaE76(lab, node.at);
        if (!nearest || d < nearest.distance) nearest = { id: node.id, distance: d };
        const w = Math.exp(-((d / h) ** 2));
        wSum += w;
        rl += w * node.residual.l;
        ra += w * node.residual.a;
        rb += w * node.residual.b;
    }
    if (wSum < 1e-9) return { lab, applied: { l: 0, a: 0, b: 0 }, weight: 0, nearest };

    // 總權重同時當作「信任程度」：離所有歷史點都遠時 wSum→0，修正自然消失
    const trust = Math.min(1, wSum);
    const applied = { l: (rl / wSum) * trust, a: (ra / wSum) * trust, b: (rb / wSum) * trust };
    return {
        lab: { l: lab.l + applied.l, a: lab.a + applied.a, b: lab.b + applied.b },
        applied, weight: trust, nearest,
    };
}

/* ------------------------------------------------------------------ *
 * 信心分數
 * ------------------------------------------------------------------ */

export const CONFIDENCE_LEVEL = { HIGH: 'high', MEDIUM: 'medium', LOW: 'low' };

/**
 * 綜合評估一次預測的可信度。分數 0–100，並附上扣分原因，讓使用者知道
 * 該不該直接打樣。
 *
 * @param {object} p
 * @param {Array<{c:number, colorant:object, model:object}>} p.items
 * @param {object|null} p.calib      校正模型（含 field 與 after 統計）
 * @param {object|null} p.residual   applyResidualField 的結果
 * @param {boolean} p.sameCarrier    配方載體與色料建檔載體是否一致
 * @param {boolean} p.hasBlank       基礎樹酯是否有量測本色
 */
export function scoreConfidence({ items, calib, residual, sameCarrier = true, hasBlank = true }) {
    let score = 100;
    const reasons = [];

    // 1) 濃度是否落在量測曲線範圍內
    for (const it of items) {
        if (!it.c || it.c <= 0) continue;
        const r = it.model && it.model.cRange;
        const name = it.colorant?.name || it.colorantId || '色料';
        if (!r) { score -= 15; reasons.push(`${name}：無濃度曲線，僅能線性假設`); continue; }
        if (it.c > r[1]) {
            // 外插扣分隨倍數遞增：剛超出只是小心，超出數倍就不該相信
            const over = it.c / Math.max(r[1], 1e-9);
            const penalty = Math.min(40, 8 + 14 * (over - 1));
            score -= penalty;
            reasons.push(over > 1.5
                ? `${name}：濃度 ${fmt(it.c)}% 達量測上限 ${fmt(r[1])}% 的 ${over.toFixed(1)} 倍，屬大幅外插`
                : `${name}：濃度 ${fmt(it.c)}% 已外插超過量測上限 ${fmt(r[1])}%`);
        } else if (it.c < r[0] * 0.5) {
            score -= 10;
            reasons.push(`${name}：濃度 ${fmt(it.c)}% 遠低於量測範圍下限 ${fmt(r[0])}%`);
        }
    }

    // 2) 擬合品質
    for (const it of items) {
        if (!it.c || it.c <= 0 || !it.model) continue;
        const r2 = Array.isArray(it.model.r2) ? Math.min(...it.model.r2) : null;
        if (r2 != null && r2 < 0.95) {
            score -= r2 < 0.85 ? 15 : 7;
            reasons.push(`${it.colorant?.name || '色料'}：濃度曲線擬合 R²=${r2.toFixed(3)}，資料離散`);
        }
    }

    // 3) 歷史配方的支撐
    if (!calib || !calib.evaluation || calib.evaluation.n === 0) {
        score -= 20;
        reasons.push('無同條件歷史配方，預測未經實測校正');
    } else {
        if (calib.evaluation.rmsDE00 > 2) {
            score -= 12;
            reasons.push(`歷史配方校正後仍有 RMS ΔE00=${calib.evaluation.rmsDE00.toFixed(2)}`);
        }
        if (residual && residual.weight < 0.25) {
            score -= 15;
            reasons.push('目標色離所有歷史配方較遠，殘差修正幾乎未生效');
        }
    }

    // 4) 載體與基材
    if (!sameCarrier) { score -= 15; reasons.push('母粒載體與色料建檔時的載體不同，屬跨載體外推'); }
    if (!hasBlank) { score -= 10; reasons.push('基礎樹酯未量測本色，使用預設值'); }

    score = Math.max(0, Math.min(100, Math.round(score)));
    const level = score >= 75 ? CONFIDENCE_LEVEL.HIGH
        : score >= 50 ? CONFIDENCE_LEVEL.MEDIUM : CONFIDENCE_LEVEL.LOW;
    return { score, level, reasons };
}

const fmt = (v) => (Math.round(v * 1000) / 1000).toString();

/**
 * 一次把校正模型建好：色力係數 + 殘差場 + 統計。
 */
export function buildCalibration(samples, substrate, opts = {}) {
    if (!samples || samples.length === 0) {
        return { strengths: {}, field: null, evaluation: { perSample: [], rmsDE00: 0, maxDE00: 0, meanDE00: 0, n: 0 }, used: [] };
    }
    const { strengths, before, after, used, rejected } = fitStrengths(samples, substrate, opts);
    const field = buildResidualField(after, opts.bandwidth ?? RESIDUAL_BANDWIDTH);
    return { strengths, field, evaluation: after, baseline: before, used, rejected: !!rejected };
}

/**
 * 套用完整校正的預測：物理模型 → 色力 → 殘差場 → 信心分數。
 */
export function predictCalibrated({ items, substrate, calib, sameCarrier = true, hasBlank = true }) {
    const withStrength = items
        .filter((it) => it.c > 0)
        .map((it) => ({ ...it, strength: calib?.strengths?.[it.colorantId] ?? 1 }));
    const raw = mixToLab(withStrength, substrate).lab;
    const res = applyResidualField(raw, calib?.field);
    const confidence = scoreConfidence({ items, calib, residual: res, sameCarrier, hasBlank });
    return { lab: res.lab, rawLab: raw, residual: res, confidence };
}

export default {
    STRENGTH_BOUNDS, RESIDUAL_BANDWIDTH, CONFIDENCE_LEVEL, calibrationKey,
    fitStrengths, evaluate, buildResidualField, applyResidualField,
    scoreConfidence, buildCalibration, predictCalibrated,
};
