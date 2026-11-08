/**
 * 多組候選配方與修色
 *
 * 反解只給一個答案不夠用。實務上「用三支色料勉強對到 ΔE 0.4」與
 * 「用兩支色料對到 ΔE 0.9」要擺在一起比，因為少一支色料在生產上
 * 省下的麻煩，往往值得那 0.5 的色差。
 */

import { solveRecipe } from './solver.js';
import { mixToLab } from './km.js';
import { deltaE00, colorDifference } from './colorUtils.js';

/**
 * 列舉色料子集，各自反解，回傳排序後的候選清單。
 *
 * @param {object} p
 * @param {{l,a,b}} p.target
 * @param {Array} p.colorants  buildSolverColorants 的結果
 * @param {object} p.substrate
 * @param {number} [p.maxComponents] 單一配方最多用幾支色料
 * @param {number} [p.limit]         最多回傳幾組
 * @param {number} [p.maxTotalC]
 * @param {Array<string>} [p.required] 必須出現在每組候選裡的色料 id（例如白）
 * @returns {Array<{ids, names, c, lab, dE00, diff, violations, usedCount, feasible}>}
 */
export function findCandidates({
    target, colorants, substrate, maxComponents = 4, limit = 6,
    maxTotalC = null, required = [],
}) {
    const n = colorants.length;
    if (!n) return [];

    const requiredIdx = required
        .map((id) => colorants.findIndex((c) => c.id === id))
        .filter((i) => i >= 0);

    const subsets = [];
    for (let mask = 1; mask < (1 << n); mask++) {
        const idx = [];
        for (let i = 0; i < n; i++) if (mask & (1 << i)) idx.push(i);
        if (idx.length > maxComponents) continue;
        if (requiredIdx.some((r) => !idx.includes(r))) continue;
        subsets.push(idx);
    }
    // 先試成分少的，結果比較好讀
    subsets.sort((a, b) => a.length - b.length);

    const out = [];
    for (const idx of subsets) {
        const subset = idx.map((i) => colorants[i]);
        const r = solveRecipe({ target, colorants: subset, substrate, maxTotalC, restarts: 10 });
        if (!r) continue;

        // 把子集的解攤回完整向量，方便 UI 對照
        const full = new Array(n).fill(0);
        idx.forEach((i, k) => { full[i] = r.c[k]; });

        // 解完可能有色料被歸零，實際用到的才算
        const usedIdx = idx.filter((i) => full[i] > 1e-9);
        if (!usedIdx.length) continue;
        // 必選色料若被求解器歸零，這組就不算數
        if (requiredIdx.some((r) => !usedIdx.includes(r))) continue;

        out.push({
            ids: usedIdx.map((i) => colorants[i].id),
            names: usedIdx.map((i) => colorants[i].name),
            c: full,
            lab: r.lab,
            dE00: r.dE00,
            diff: r.diff,
            violations: r.violations,
            usedCount: usedIdx.length,
            feasible: r.violations.length === 0,
            totalC: full.reduce((s, v) => s + v, 0),
        });
    }

    // 同一組色料可能從不同子集重複算出來，只留最好的
    const bestByKey = new Map();
    for (const cand of out) {
        const key = [...cand.ids].sort().join('|');
        const prev = bestByKey.get(key);
        if (!prev || cand.dE00 < prev.dE00) bestByKey.set(key, cand);
    }

    return [...bestByKey.values()]
        .sort((a, b) => {
            if (a.feasible !== b.feasible) return a.feasible ? -1 : 1;
            return a.dE00 - b.dE00;
        })
        .slice(0, limit);
}

/* ------------------------------------------------------------------ *
 * 修色
 * ------------------------------------------------------------------ */

/**
 * 修色：手上已經打出一片試片，量到的顏色與目標有差，問各成分該加減多少。
 *
 * 作法是把「實測 − 模型預測」當成這批料的局部偏差，假設在小範圍內固定，
 * 然後在帶這個偏差的模型上重新求解。這比單純重跑反解準得多，因為
 * 偏差裡包含了這一爐料真實的分散狀況與機台條件。
 *
 * @param {object} p
 * @param {Array} p.colorants   buildSolverColorants 的結果
 * @param {number[]} p.current  目前各色料的有效濃度 (wt%)
 * @param {{l,a,b}} p.measured  試片實測色
 * @param {{l,a,b}} p.target    目標色
 * @param {object} p.substrate
 * @param {boolean} [p.addOnly] 只能添加不能減少（料已經在桶子裡了）
 * @param {number} [p.maxTotalC]
 * @returns {{c, delta, lab, dE00, before, bias, violations, addOnly}}
 */
export function correctBatch({
    colorants, current, measured, target, substrate,
    addOnly = false, maxTotalC = null,
}) {
    const items = colorants.map((col, i) => ({ model: col.model, c: current[i], strength: col.strength }));
    const predicted = mixToLab(items.filter((it) => it.c > 0), substrate).lab;

    // 這一爐的局部偏差
    const bias = {
        l: measured.l - predicted.l,
        a: measured.a - predicted.a,
        b: measured.b - predicted.b,
    };

    // 帶偏差的模型：模型算完再加上這批料的偏差，才是預期會量到的顏色
    const biased = (cs) => {
        const lab = mixToLab(
            colorants.map((col, i) => ({ model: col.model, c: cs[i], strength: col.strength }))
                .filter((it) => it.c > 0),
            substrate,
        ).lab;
        return { l: lab.l + bias.l, a: lab.a + bias.a, b: lab.b + bias.b };
    };

    // 只能加料時，下限就是目前濃度
    const adjusted = colorants.map((col, i) => ({
        ...col,
        minC: addOnly ? Math.max(col.minC || 0, current[i]) : col.minC,
    }));

    // 用帶偏差的模型求解：把 target 反向平移，等價於在原模型上求解
    const shiftedTarget = { l: target.l - bias.l, a: target.a - bias.a, b: target.b - bias.b };
    const r = solveRecipe({
        target: shiftedTarget, colorants: adjusted, substrate, maxTotalC, restarts: 14,
    });
    if (!r) return null;

    let c = r.c;
    if (addOnly) c = c.map((v, i) => Math.max(v, current[i]));

    const finalLab = biased(c);
    return {
        c,
        delta: c.map((v, i) => v - current[i]),
        lab: finalLab,
        dE00: deltaE00(finalLab, target),
        diff: colorDifference(finalLab, target),
        before: { lab: measured, dE00: deltaE00(measured, target), diff: colorDifference(measured, target) },
        predicted,
        bias,
        violations: r.violations,
        addOnly,
    };
}

/**
 * 把修色結果換算成「現場要加多少公斤」。
 * @param {number} batchKg 這批料的總重
 */
export function correctionToWeights(correction, colorants, batchKg) {
    return correction.delta.map((dc, i) => {
        const col = colorants[i].colorant;
        const loading = col?.pigmentLoading ?? 100;
        const dDosage = (dc * 100) / loading;          // 色母添加量的變化 (wt%)
        return {
            id: colorants[i].id,
            name: colorants[i].name,
            deltaC: dc,
            deltaDosage: dDosage,
            kg: (dDosage / 100) * batchKg,
        };
    });
}

export default { findCandidates, correctBatch, correctionToWeights };
