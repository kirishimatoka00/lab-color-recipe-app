/**
 * 求解器：正算、反解、置換模擬、可達色域
 *
 * 反解的難處在於約束是「非連續」的：某支色料要嘛不用 (c=0)，要用就必須
 * 高於最低含量 (c ≥ minFinalPct)。中間那段是禁區。
 * 作法：先在 [0, max] 上做連續最佳化，若有解落在禁區，就對這些色料分別
 * 試「拉到最低含量」與「歸零」兩種分支再重解，取最佳者。色料數不多（通常 ≤6），
 * 分支數可控。
 */

import { mixToLab } from './km.js';
import { deltaE00, deltaE76, colorDifference } from './colorUtils.js';

/* ------------------------------------------------------------------ *
 * 正算
 * ------------------------------------------------------------------ */

/**
 * @param {Array<{model, c, strength?}>} items
 * @param {object} substrate
 */
export function predictLab(items, substrate) {
    return mixToLab(items.filter((it) => it.c > 0), substrate).lab;
}

/* ------------------------------------------------------------------ *
 * 有界 Nelder-Mead
 * ------------------------------------------------------------------ */

function clampVec(x, lo, hi) {
    return x.map((v, i) => Math.min(Math.max(v, lo[i]), hi[i]));
}

/**
 * 有界 Nelder-Mead。以夾擠處理邊界，對本問題（平滑、低維）夠用且不需梯度。
 */
export function nelderMead(fn, x0, lo, hi, opts = {}) {
    const n = x0.length;
    if (n === 0) return { x: [], f: fn([]) };
    const maxIter = opts.maxIter ?? 400 * n;
    const tol = opts.tol ?? 1e-7;
    const step = opts.step ?? x0.map((v, i) => Math.max((hi[i] - lo[i]) * 0.1, 1e-3));

    const ev = (x) => { const c = clampVec(x, lo, hi); return { x: c, f: fn(c) }; };

    let simplex = [ev(x0)];
    for (let i = 0; i < n; i++) {
        const x = x0.slice();
        x[i] = x[i] + step[i] <= hi[i] ? x[i] + step[i] : x[i] - step[i];
        simplex.push(ev(x));
    }

    for (let iter = 0; iter < maxIter; iter++) {
        simplex.sort((a, b) => a.f - b.f);
        if (Math.abs(simplex[n].f - simplex[0].f) < tol) break;

        const centroid = new Array(n).fill(0);
        for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) centroid[j] += simplex[i].x[j] / n;

        const worst = simplex[n];
        const refl = ev(centroid.map((c, j) => c + (c - worst.x[j])));
        if (refl.f < simplex[0].f) {
            const exp = ev(centroid.map((c, j) => c + 2 * (c - worst.x[j])));
            simplex[n] = exp.f < refl.f ? exp : refl;
        } else if (refl.f < simplex[n - 1].f) {
            simplex[n] = refl;
        } else {
            const contr = ev(centroid.map((c, j) => c + 0.5 * (worst.x[j] - c)));
            if (contr.f < worst.f) simplex[n] = contr;
            else {
                const best = simplex[0];
                for (let i = 1; i <= n; i++) {
                    simplex[i] = ev(simplex[i].x.map((v, j) => best.x[j] + 0.5 * (v - best.x[j])));
                }
            }
        }
    }
    simplex.sort((a, b) => a.f - b.f);
    return simplex[0];
}

/* ------------------------------------------------------------------ *
 * 反解：目標色 → 配方
 * ------------------------------------------------------------------ */

/**
 * @param {object} p
 * @param {{l,a,b}} p.target        目標色
 * @param {Array} p.colorants       [{ id, name, model, minC, maxC, strength }]
 * @param {object} p.substrate
 * @param {number} [p.maxTotalC]    所有顏料有效濃度總和上限 (wt%)
 * @param {number} [p.restarts]     多起點次數
 * @returns {{c:number[], lab, dE00, dE76, diff, violations, iterations}}
 */
export function solveRecipe({ target, colorants, substrate, maxTotalC = null, restarts = 12 }) {
    const n = colorants.length;
    if (n === 0) return null;

    const lo = colorants.map(() => 0);
    const hi = colorants.map((c) => (c.maxC && c.maxC > 0 ? c.maxC : guessUpper(c)));

    const objective = (cs) => {
        if (maxTotalC) {
            const tot = cs.reduce((s, v) => s + v, 0);
            if (tot > maxTotalC) return 1e3 + (tot - maxTotalC) * 1e3; // 罰項
        }
        const items = colorants.map((col, i) => ({ model: col.model, c: cs[i], strength: col.strength }));
        return deltaE00(mixToLab(items.filter((it) => it.c > 0), substrate).lab, target);
    };

    // --- 連續階段：多起點 ---
    let best = null;
    const starts = buildStarts(colorants, hi, restarts);
    for (const s of starts) {
        const r = nelderMead(objective, s, lo, hi, { tol: 1e-8 });
        if (!best || r.f < best.f) best = r;
    }

    // --- 禁區修復：0 < c < minC 的色料要嘛拉到 minC，要嘛歸零 ---
    const result = repairMinimums(best, colorants, lo, hi, objective);

    const cs = result.x.map((v) => (v < 1e-6 ? 0 : v));
    const items = colorants.map((col, i) => ({ model: col.model, c: cs[i], strength: col.strength }));
    const lab = mixToLab(items.filter((it) => it.c > 0), substrate).lab;

    return {
        c: cs,
        lab,
        dE00: deltaE00(lab, target),
        dE76: deltaE76(lab, target),
        diff: colorDifference(lab, target),
        violations: minViolations(cs, colorants),
        inRange: cs.map((c, i) => inMeasuredRange(c, colorants[i])),
    };
}

/** 色料沒給上限時，取量測曲線上限的 2 倍作為搜尋範圍 */
function guessUpper(col) {
    const r = col.model && col.model.cRange;
    const top = r ? r[1] : 2;
    return Math.max(top * 2, 0.5);
}

function buildStarts(colorants, hi, restarts) {
    const n = colorants.length;
    const starts = [];
    // 起點 1：各自取量測範圍中點
    starts.push(colorants.map((col, i) => {
        const r = col.model && col.model.cRange;
        return Math.min(r ? (r[0] + r[1]) / 2 : hi[i] * 0.2, hi[i]);
    }));
    // 起點 2：全部取最低含量
    starts.push(colorants.map((col, i) => Math.min(Math.max(col.minC || 0, hi[i] * 0.02), hi[i])));
    // 其餘：確定性偽隨機，確保結果可重現
    let seed = 20260101;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    for (let k = starts.length; k < restarts; k++) {
        starts.push(Array.from({ length: n }, (_, i) => rnd() * hi[i] * 0.6));
    }
    return starts;
}

function minViolations(cs, colorants) {
    const out = [];
    cs.forEach((c, i) => {
        const col = colorants[i];
        if (c > 1e-9 && col.minC > 0 && c < col.minC - 1e-9) {
            out.push({ id: col.id, name: col.name, value: c, limit: col.minC, kind: 'below_min' });
        }
    });
    return out;
}

function inMeasuredRange(c, col) {
    if (c <= 0) return true;
    const r = col.model && col.model.cRange;
    if (!r) return false;
    return c >= r[0] - 1e-9 && c <= r[1] + 1e-9;
}

/**
 * 修復落在禁區的解。對每支違規色料試兩個分支（拉到 minC / 歸零），
 * 固定該變數後重解其餘，取 ΔE 最小者。違規數多時限制分支量避免爆炸。
 */
function repairMinimums(best, colorants, lo, hi, objective) {
    const offenders = [];
    best.x.forEach((c, i) => {
        const m = colorants[i].minC || 0;
        if (c > 1e-9 && m > 0 && c < m - 1e-9) offenders.push(i);
    });
    if (offenders.length === 0) return best;

    const limited = offenders.slice(0, 5); // 2^5 = 32 個分支，夠用
    const branches = 1 << limited.length;
    let bestFixed = null;

    for (let mask = 0; mask < branches; mask++) {
        const fixed = {};
        limited.forEach((idx, bit) => {
            fixed[idx] = (mask >> bit) & 1 ? Math.min(colorants[idx].minC, hi[idx]) : 0;
        });
        const freeIdx = colorants.map((_, i) => i).filter((i) => !(i in fixed));
        const expand = (sub) => {
            const full = new Array(colorants.length).fill(0);
            freeIdx.forEach((i, k) => { full[i] = sub[k]; });
            for (const i in fixed) full[i] = fixed[i];
            return full;
        };
        const subObj = (sub) => objective(expand(sub));
        const sub0 = freeIdx.map((i) => best.x[i]);
        const r = freeIdx.length
            ? nelderMead(subObj, sub0, freeIdx.map((i) => lo[i]), freeIdx.map((i) => hi[i]), { tol: 1e-8 })
            : { x: [], f: subObj([]) };
        const full = expand(r.x);
        const f = objective(full);
        if (!bestFixed || f < bestFixed.f) bestFixed = { x: full, f };
    }
    return bestFixed && bestFixed.f < best.f + 0.5 ? bestFixed : (bestFixed || best);
}

/* ------------------------------------------------------------------ *
 * 置換模擬
 * ------------------------------------------------------------------ */

/**
 * 把配方裡的某支色料換成另一支，回報顏色落點與位移。
 * 預設維持「有效濃度」不變；mode='matchDosage' 則維持色母添加量不變。
 */
export function substitute({ items, substrate, index, newModel, newC = null }) {
    const before = mixToLab(items.filter((i) => i.c > 0), substrate).lab;
    const after = items.map((it, i) =>
        i === index ? { model: newModel, c: newC == null ? it.c : newC, strength: it.strength } : it);
    const afterLab = mixToLab(after.filter((i) => i.c > 0), substrate).lab;
    return { before, after: afterLab, diff: colorDifference(afterLab, before), dE00: deltaE00(afterLab, before) };
}

/**
 * 單一成分的劑量掃描：這支加減多少，顏色往哪走。
 * @returns {Array<{c, lab, dE00FromBase}>}
 */
export function dosageScan({ items, substrate, index, from, to, steps = 21 }) {
    const base = mixToLab(items.filter((i) => i.c > 0), substrate).lab;
    const out = [];
    for (let s = 0; s < steps; s++) {
        const c = from + ((to - from) * s) / (steps - 1);
        const trial = items.map((it, i) => (i === index ? { ...it, c } : it));
        const lab = mixToLab(trial.filter((i) => i.c > 0), substrate).lab;
        out.push({ c, lab, dE00FromBase: deltaE00(lab, base) });
    }
    return out;
}

/* ------------------------------------------------------------------ *
 * 可達色域取樣
 * ------------------------------------------------------------------ */

/**
 * 在劑量單純形上取樣，產生這組色料在此基材上「做得出來的顏色」點雲。
 * 輸出可直接餵給既有的 GamutUtils 凸包 / 切面邏輯。
 *
 * 取樣遵守最低含量：每支色料不是 0，就是 ≥ minC。
 *
 * @param {Array} colorants [{ id, model, minC, maxC }]
 * @param {object} substrate
 * @param {number} samplesPerCombo 每個「用到哪幾支」的組合取幾點
 */
export function reachableGamut(colorants, substrate, { samplesPerCombo = 120, maxTotalC = null } = {}) {
    const n = colorants.length;
    const pts = [];
    let seed = 7919;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

    const combos = [];
    for (let mask = 1; mask < (1 << n); mask++) combos.push(mask);

    for (const mask of combos) {
        const idx = [];
        for (let i = 0; i < n; i++) if (mask & (1 << i)) idx.push(i);
        const per = Math.max(8, Math.round(samplesPerCombo / Math.max(1, idx.length)));
        for (let s = 0; s < per; s++) {
            const items = [];
            let total = 0;
            for (const i of idx) {
                const col = colorants[i];
                const lowC = Math.max(col.minC || 0, col.model?.cRange?.[0] ?? 0, 1e-4);
                const highC = col.maxC && col.maxC > 0 ? col.maxC : guessUpper(col);
                if (highC <= lowC) continue;
                const c = lowC + rnd() * (highC - lowC);
                total += c;
                items.push({ model: col.model, c, strength: col.strength });
            }
            if (!items.length) continue;
            if (maxTotalC && total > maxTotalC) continue;
            const lab = mixToLab(items, substrate).lab;
            pts.push({ ...lab, mask });
        }
    }
    return pts;
}

export default {
    predictLab, nelderMead, solveRecipe, substitute, dosageScan, reachableGamut,
};
