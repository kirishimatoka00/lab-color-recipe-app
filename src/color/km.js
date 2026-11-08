/**
 * Kubelka-Munk 色彩預測引擎（白還原法 / white-reduction）
 *
 * 背景：本專案目前沒有光譜資料，只有 Lab。因此把 Lab 轉成三通道「擬反射率」
 * （XYZ 對 D65 白點正規化），在這三個通道上跑 KM，再轉回 Lab。
 *
 * 模型（每個通道 j 獨立）：
 *     K_mix,j = K_resin,j + Σ_i kContrib_i,j(c_i)
 *     S_mix,j = S_resin,j + Σ_i sContrib_i,j(c_i)
 *     (K/S)_j = K_mix,j / S_mix,j
 *     R_j     = 1 + (K/S)_j − sqrt((K/S)_j² + 2(K/S)_j)
 *
 * 約定：基礎樹酯的散射定為 S_resin = 1（散射的絕對尺度不可觀測，只有比值有意義）。
 *
 * 色料分兩類：
 *  - 彩色料（含黑）：假設只吸收不散射（sContrib = 0）。這是「在固定白階下做還原」
 *    的標準簡化，色母廠慣用。
 *  - 白（TiO2）：散射主導，k 與 s 都要擬合，因此白一定要有自己的濃度曲線。
 *
 * 因為彩色料的 s 設為 0，從一筆量測值反推它的吸收貢獻是線性的：
 *     kContrib = (K/S)_obs × S_mix − K_resin − (白的 k 貢獻)
 * 其中 S_mix 由基礎樹酯與該曲線量測時的白階決定，兩者都已知。
 *
 * 濃度→吸收的函數形式依資料點數決定（見 fitColorant）。
 */

import { labToXyz, xyzToLab, D65, clamp } from './colorUtils.js';

/** 擬反射率的下限，避免 K/S 發散 */
const R_MIN = 1e-4;
const R_MAX = 1 - 1e-6;

/** Lab → 三通道擬反射率 [Rx, Ry, Rz] */
export function labToPseudoR(lab) {
    const [X, Y, Z] = labToXyz(lab.l, lab.a, lab.b);
    return [
        clamp(X / D65.X, R_MIN, R_MAX),
        clamp(Y / D65.Y, R_MIN, R_MAX),
        clamp(Z / D65.Z, R_MIN, R_MAX),
    ];
}

/** 三通道擬反射率 → Lab */
export function pseudoRToLab(R) {
    return xyzToLab(R[0] * D65.X, R[1] * D65.Y, R[2] * D65.Z);
}

/** 單一反射率 → K/S */
export const rToKS = (r) => {
    const R = clamp(r, R_MIN, R_MAX);
    return ((1 - R) * (1 - R)) / (2 * R);
};

/** K/S → 反射率（KM 不透明解） */
export const ksToR = (ks) => {
    const k = Math.max(0, ks);
    return clamp(1 + k - Math.sqrt(k * k + 2 * k), R_MIN, R_MAX);
};

/** Lab → 三通道 K/S */
export function labToKS(lab) {
    return labToPseudoR(lab).map(rToKS);
}

/** 三通道 K/S → Lab */
export function ksToLab(ks) {
    return pseudoRToLab(ks.map(ksToR));
}

/* ------------------------------------------------------------------ *
 * 基材（基礎樹酯 / 載體）
 * ------------------------------------------------------------------ */

/** S_resin 的參考尺度。所有 k、s 都相對於這個值。 */
export const S_RESIN = 1;

/**
 * 由基礎樹酯本色 Lab 建出基材參數。
 * @param {{l:number,a:number,b:number}} blankLab 未著色樹酯的量測 Lab
 */
export function makeSubstrate(blankLab) {
    const ks = labToKS(blankLab);
    return {
        K: ks.map((v) => v * S_RESIN),   // K_resin = (K/S) × S_resin
        S: [S_RESIN, S_RESIN, S_RESIN],
        blankLab: { ...blankLab },
    };
}

/** 沒有量測本色時的預設基材（接近未著色 PP/PE 的自然色） */
export const DEFAULT_BLANK_LAB = { l: 92, a: -0.6, b: 2.4 };

/* ------------------------------------------------------------------ *
 * 濃度 → 吸收/散射 貢獻的函數形式
 * ------------------------------------------------------------------ */

/**
 * 依資料點數選擇擬合形式：
 *   3 點      → 線性（γ=1），只擬合 α。點太少，放開次方必過擬合。
 *   4–6 點    → 冪次 α·c^γ，γ 在 [0.45, 1.6] 網格搜尋後取最小殘差。
 *   7 點以上  → 單調 PCHIP 內插，界外走端點斜率線性外插。
 */
export const FIT_FORM = { LINEAR: 'linear', POWER: 'power', PCHIP: 'pchip' };

export function chooseFitForm(n) {
    if (n >= 7) return FIT_FORM.PCHIP;
    if (n >= 4) return FIT_FORM.POWER;
    return FIT_FORM.LINEAR;
}

/** 過原點的最小二乘：y ≈ α·x */
function fitThroughOrigin(xs, ys) {
    let num = 0, den = 0;
    for (let i = 0; i < xs.length; i++) { num += xs[i] * ys[i]; den += xs[i] * xs[i]; }
    return den > 1e-15 ? num / den : 0;
}

function r2Of(ys, preds) {
    const mean = ys.reduce((s, v) => s + v, 0) / (ys.length || 1);
    let ssRes = 0, ssTot = 0;
    for (let i = 0; i < ys.length; i++) {
        ssRes += (ys[i] - preds[i]) ** 2;
        ssTot += (ys[i] - mean) ** 2;
    }
    return ssTot > 1e-15 ? 1 - ssRes / ssTot : (ssRes < 1e-15 ? 1 : 0);
}

/** 單調 PCHIP（Fritsch-Carlson）係數 */
function pchipSlopes(xs, ys) {
    const n = xs.length;
    if (n === 2) { const s = (ys[1] - ys[0]) / (xs[1] - xs[0]); return [s, s]; }
    const h = [], d = [];
    for (let i = 0; i < n - 1; i++) { h.push(xs[i + 1] - xs[i]); d.push((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i])); }
    const m = new Array(n).fill(0);
    for (let i = 1; i < n - 1; i++) {
        if (d[i - 1] * d[i] <= 0) { m[i] = 0; continue; }
        const w1 = 2 * h[i] + h[i - 1];
        const w2 = h[i] + 2 * h[i - 1];
        m[i] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i]);
    }
    const endSlope = (hA, hB, dA, dB) => {
        let s = ((2 * hA + hB) * dA - hA * dB) / (hA + hB);
        if (s * dA <= 0) s = 0;
        else if (dA * dB <= 0 && Math.abs(s) > Math.abs(3 * dA)) s = 3 * dA;
        return s;
    };
    m[0] = endSlope(h[0], h[1], d[0], d[1]);
    m[n - 1] = endSlope(h[n - 2], h[n - 3], d[n - 2], d[n - 3]);
    return m;
}

function pchipEval(xs, ys, ms, x) {
    const n = xs.length;
    if (x <= xs[0]) return ys[0] + ms[0] * (x - xs[0]);                 // 線性外插
    if (x >= xs[n - 1]) return ys[n - 1] + ms[n - 1] * (x - xs[n - 1]); // 線性外插
    let i = 0;
    while (i < n - 2 && x > xs[i + 1]) i++;
    const h = xs[i + 1] - xs[i];
    const t = (x - xs[i]) / h;
    const t2 = t * t, t3 = t2 * t;
    const h00 = 2 * t3 - 3 * t2 + 1;
    const h10 = t3 - 2 * t2 + t;
    const h01 = -2 * t3 + 3 * t2;
    const h11 = t3 - t2;
    return h00 * ys[i] + h10 * h * ms[i] + h01 * ys[i + 1] + h11 * h * ms[i + 1];
}

/**
 * 擬合「濃度 → 單通道吸收貢獻」曲線。
 * @param {number[]} cs 有效濃度（最終製品中的 wt%）
 * @param {number[]} ks 對應的吸收貢獻
 * @returns {{form:string, eval:(c:number)=>number, params:object, r2:number}}
 */
export function fitChannel(cs, ks, form) {
    // 加入原點：濃度 0 時貢獻為 0，這是物理約束
    const xs = [0, ...cs];
    const ys = [0, ...ks];
    // 依濃度排序並合併重複
    const order = xs.map((v, i) => i).sort((p, q) => xs[p] - xs[q]);
    const sx = [], sy = [];
    for (const i of order) {
        if (sx.length && Math.abs(xs[i] - sx[sx.length - 1]) < 1e-12) {
            sy[sy.length - 1] = (sy[sy.length - 1] + ys[i]) / 2;
        } else { sx.push(xs[i]); sy.push(ys[i]); }
    }

    if (form === FIT_FORM.PCHIP && sx.length >= 3) {
        const ms = pchipSlopes(sx, sy);
        const fn = (c) => Math.max(0, pchipEval(sx, sy, ms, c));
        return { form: FIT_FORM.PCHIP, eval: fn, params: { xs: sx, ys: sy, ms }, r2: 1 };
    }

    if (form === FIT_FORM.POWER) {
        let best = null;
        for (let g = 0.45; g <= 1.605; g += 0.05) {
            const xg = cs.map((c) => Math.pow(Math.max(c, 0), g));
            const alpha = fitThroughOrigin(xg, ks);
            const preds = xg.map((v) => alpha * v);
            const r2 = r2Of(ks, preds);
            const sse = ks.reduce((s, y, i) => s + (y - preds[i]) ** 2, 0);
            if (!best || sse < best.sse) best = { alpha, gamma: g, sse, r2 };
        }
        const { alpha, gamma, r2 } = best;
        return {
            form: FIT_FORM.POWER,
            eval: (c) => alpha * Math.pow(Math.max(c, 0), gamma),
            params: { alpha, gamma }, r2,
        };
    }

    const alpha = fitThroughOrigin(cs, ks);
    const r2 = r2Of(ks, cs.map((c) => alpha * c));
    return { form: FIT_FORM.LINEAR, eval: (c) => alpha * Math.max(c, 0), params: { alpha, gamma: 1 }, r2 };
}

/* ------------------------------------------------------------------ *
 * 色料擬合
 * ------------------------------------------------------------------ */

/**
 * 擬合白色料（TiO2）：k 與 s 都未知，逐通道做 Gauss-Newton。
 * 模型：(K/S)(c) = (K_sub + c·kw) / (S_sub + c·sw)
 *
 * @param {Array<{c:number, lab:object}>} pts c = 白顏料在最終製品的有效濃度 (wt%)
 * @param {object} substrate makeSubstrate() 的結果
 */
export function fitWhite(pts, substrate) {
    const kw = [0, 0, 0], sw = [0, 0, 0], r2 = [0, 0, 0];
    const obs = pts.map((p) => ({ c: p.c, ks: labToKS(p.lab) }));

    for (let j = 0; j < 3; j++) {
        const Ks = substrate.K[j], Ss = substrate.S[j];
        const ys = obs.map((o) => o.ks[j]);
        const cs = obs.map((o) => o.c);

        // 網格起點 + Gauss-Newton 細修。白的散射遠大於基材，sw 跨幾個數量級，用對數網格。
        let best = null;
        for (let le = -2; le <= 3.01; le += 0.25) {
            const s = Math.pow(10, le);
            // 給定 sw，對 kw 是線性的： ks·(Ss + c·s) − Ks = c·kw
            const xs2 = cs.map((c) => c);
            const ys2 = cs.map((c, i) => ys[i] * (Ss + c * s) - Ks);
            let k = fitThroughOrigin(xs2, ys2);
            k = Math.max(0, k);
            const preds = cs.map((c) => (Ks + c * k) / (Ss + c * s));
            const sse = ys.reduce((acc, y, i) => acc + (y - preds[i]) ** 2, 0);
            if (!best || sse < best.sse) best = { k, s, sse };
        }
        // 以最佳網格點為起點再做一次細網格
        const s0 = best.s;
        for (let m = 0.6; m <= 1.65; m += 0.05) {
            const s = s0 * m;
            const ys2 = cs.map((c, i) => ys[i] * (Ss + c * s) - Ks);
            let k = Math.max(0, fitThroughOrigin(cs, ys2));
            const preds = cs.map((c) => (Ks + c * k) / (Ss + c * s));
            const sse = ys.reduce((acc, y, i) => acc + (y - preds[i]) ** 2, 0);
            if (sse < best.sse) best = { k, s, sse };
        }

        kw[j] = best.k;
        sw[j] = best.s;
        r2[j] = r2Of(ys, cs.map((c) => (Ks + c * best.k) / (Ss + c * best.s)));
    }

    return { type: 'white', k: kw, s: sw, r2, form: FIT_FORM.LINEAR };
}

/**
 * 擬合彩色料（含黑）。假設只吸收不散射。
 * 曲線上每一點都要記錄當時的白階（whiteC，白顏料在最終製品的有效濃度），
 * 沒有白就填 0。
 *
 * @param {Array<{c:number, lab:object, whiteC?:number}>} pts
 * @param {object} substrate
 * @param {object|null} white fitWhite() 的結果；曲線含白時必填
 */
export function fitColorant(pts, substrate, white = null) {
    const n = pts.length;
    const form = chooseFitForm(n);
    const cs = pts.map((p) => p.c);
    const kByChannel = [[], [], []];

    for (const p of pts) {
        const ks = labToKS(p.lab);
        const w = p.whiteC || 0;
        for (let j = 0; j < 3; j++) {
            const Smix = substrate.S[j] + (white && w ? w * white.s[j] : 0);
            const Kother = substrate.K[j] + (white && w ? w * white.k[j] : 0);
            // 反推這支色料在這個濃度下的吸收貢獻
            kByChannel[j].push(Math.max(0, ks[j] * Smix - Kother));
        }
    }

    const channels = [];
    for (let j = 0; j < 3; j++) channels.push(fitChannel(cs, kByChannel[j], form));

    return {
        type: 'chromatic',
        form,
        channels,
        r2: channels.map((c) => c.r2),
        cRange: [Math.min(...cs), Math.max(...cs)],
        kAt: (c) => channels.map((ch) => ch.eval(c)),
        sAt: () => [0, 0, 0],
    };
}

/* ------------------------------------------------------------------ *
 * 正算：配方 → 顏色
 * ------------------------------------------------------------------ */

/**
 * @param {Array<{model:object, c:number, strength?:number}>} items
 *        model 為 fitColorant / fitWhite 的結果，c 為該顏料在最終製品的有效濃度 (wt%)，
 *        strength 為校正層給的色力係數（預設 1）。
 * @param {object} substrate
 * @returns {{lab:object, ks:number[], R:number[]}}
 */
export function mixToLab(items, substrate) {
    const K = [...substrate.K];
    const S = [...substrate.S];

    for (const it of items) {
        const f = it.strength == null ? 1 : it.strength;
        if (!it.c || it.c <= 0) continue;
        if (it.model.type === 'white') {
            for (let j = 0; j < 3; j++) {
                K[j] += f * it.c * it.model.k[j];
                S[j] += f * it.c * it.model.s[j];
            }
        } else {
            const kc = it.model.kAt(it.c);
            for (let j = 0; j < 3; j++) K[j] += f * kc[j];
        }
    }

    const ks = [0, 1, 2].map((j) => K[j] / Math.max(S[j], 1e-9));
    const R = ks.map(ksToR);
    return { lab: pseudoRToLab(R), ks, R };
}

export default {
    labToPseudoR, pseudoRToLab, rToKS, ksToR, labToKS, ksToLab,
    makeSubstrate, DEFAULT_BLANK_LAB, S_RESIN,
    FIT_FORM, chooseFitForm, fitChannel, fitWhite, fitColorant, mixToLab,
};
