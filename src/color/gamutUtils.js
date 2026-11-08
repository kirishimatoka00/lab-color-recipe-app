/**
 * 色域幾何工具
 *
 * 與 lab-color-app 的版本差別：那邊吃 three.js 的 ConvexGeometry mesh，
 * 這邊吃「Lab 點雲」。因為本專案的色域來自 solver.reachableGamut 的取樣結果，
 * 而且點雲版可以在 node 裡測試，不必拉起 WebGL。
 *
 * 等 L 截面的作法：取 L 落在 [L-δ, L+δ] 帶內的點做 a-b 凸包。取樣夠密時
 * 與真正的幾何切面幾乎一致，而且省掉實作 3D 凸包。
 */

export const GAMUT_MODE = { PROJECTION: 'projection', SLICE: 'slice' };

/** 2D 凸包（Monotone chain），回傳逆時針多邊形 */
export function hull2D(input) {
    const pts = input.map((q) => [q[0], q[1]]).sort((u, w) => u[0] - w[0] || u[1] - w[1]);
    if (pts.length < 3) return pts;
    const cross = (o, p1, p2) => (p1[0] - o[0]) * (p2[1] - o[1]) - (p1[1] - o[1]) * (p2[0] - o[0]);
    const lower = [];
    for (const q of pts) {
        while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 1e-12) lower.pop();
        lower.push(q);
    }
    const upper = [];
    for (let i = pts.length - 1; i >= 0; i--) {
        const q = pts[i];
        while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 1e-12) upper.pop();
        upper.push(q);
    }
    lower.pop(); upper.pop();
    return lower.concat(upper);
}

export function insidePoly(poly, x, y) {
    const n = poly.length;
    if (n < 3) return false;
    return poly.every((P, i) => {
        const Q = poly[(i + 1) % n];
        return (Q[0] - P[0]) * (y - P[1]) - (Q[1] - P[1]) * (x - P[0]) >= -1e-9;
    });
}

/** 多邊形（含邊界）上離 (x,y) 最近的點 */
export function nearestOnPoly(poly, x, y) {
    let best = null, bd = Infinity;
    const n = poly.length;
    for (let i = 0; i < n; i++) {
        const P = poly[i], Q = poly[(i + 1) % n];
        const dx = Q[0] - P[0], dy = Q[1] - P[1];
        const len2 = dx * dx + dy * dy;
        let t = len2 < 1e-12 ? 0 : ((x - P[0]) * dx + (y - P[1]) * dy) / len2;
        t = Math.max(0, Math.min(1, t));
        const cx = P[0] + t * dx, cy = P[1] + t * dy;
        const d = (cx - x) ** 2 + (cy - y) ** 2;
        if (d < bd) { bd = d; best = [cx, cy]; }
    }
    return best;
}

/** 整個點雲投影到 a-b 平面的凸包 */
export const projectAB = (points) =>
    points.length >= 3 ? hull2D(points.map((p) => [p.a, p.b])) : null;

export function lRange(points) {
    let lo = Infinity, hi = -Infinity;
    for (const p of points) { if (p.l < lo) lo = p.l; if (p.l > hi) hi = p.l; }
    return [lo, hi];
}

/**
 * 等 L 截面。帶寬 δ 自動放大直到帶內有足夠的點，避免稀疏處回傳空集合。
 */
export function sliceAtL(points, L, { band = 2, minPts = 12, maxBand = 15 } = {}) {
    let δ = band;
    while (δ <= maxBand) {
        const inBand = points.filter((p) => Math.abs(p.l - L) <= δ);
        if (inBand.length >= minPts) {
            const h = hull2D(inBand.map((p) => [p.a, p.b]));
            if (h.length >= 3) return h;
        }
        δ *= 1.8;
    }
    return null;
}

/**
 * 通過 L 軸、色相角 H（弧度）的半平面截面，座標為 [Chroma, L]。
 */
export function sliceAtHue(points, H, { band = 12, minPts = 12, maxBand = 60 } = {}) {
    const ch = Math.cos(H), sh = Math.sin(H);
    let δ = band;
    while (δ <= maxBand) {
        const mapped = [];
        for (const p of points) {
            const perp = -p.a * sh + p.b * ch;      // 離半平面的距離
            const chroma = p.a * ch + p.b * sh;      // 沿色相方向的投影
            if (Math.abs(perp) <= δ && chroma >= 0) mapped.push([chroma, p.l]);
        }
        if (mapped.length >= minPts) {
            const h = hull2D(mapped);
            if (h.length >= 3) return h;
        }
        δ *= 1.8;
    }
    return null;
}

/**
 * In Gamut 判定與三種修正，沿用 lab-color-app 的 C1 / C2 / C3 定義：
 *   C1：Chroma 維持、調整 Hue
 *   C2：Hue 維持、降低 Chroma
 *   C3：最小 ΔE（建議）
 *
 * @param {{l,a,b}} pt
 * @param {Array<{l,a,b}>} points 色域點雲
 * @param {string} mode GAMUT_MODE
 */
export function calculateCorrections(pt, points, mode = GAMUT_MODE.PROJECTION) {
    if (!pt || !points || points.length < 3) return null;
    const slice = mode === GAMUT_MODE.SLICE;

    let Lc = pt.l, lInRange = true;
    if (slice) {
        const [minL, maxL] = lRange(points);
        lInRange = pt.l >= minL && pt.l <= maxL;
        const margin = Math.min(0.05, (maxL - minL) / 4);
        Lc = lInRange ? pt.l : Math.min(maxL - margin, Math.max(minL + margin, pt.l));
    }

    const poly = slice ? sliceAtL(points, Lc) : projectAB(points);
    if (!poly) return { isInside: false, noSlice: true };

    const inside = insidePoly(poly, pt.a, pt.b);
    if (lInRange && inside) return { isInside: true };

    const C = Math.hypot(pt.a, pt.b);
    const H = Math.atan2(pt.b, pt.a);
    const hueDeg = (rad) => { const d = (rad * 180) / Math.PI; return d < 0 ? d + 360 : d; };
    const make = (l, a, b) => {
        let dh = hueDeg(Math.atan2(b, a)) - hueDeg(H);
        dh = ((dh + 540) % 360) - 180;
        const dl = l - pt.l, da = a - pt.a, db = b - pt.b;
        return {
            l, a, b, dl, da, db,
            dC: Math.hypot(a, b) - C,
            dH: C < 1e-6 ? 0 : dh,
            dE: Math.sqrt(dl * dl + da * da + db * db),
        };
    };
    const wrap = (x) => { let d = x; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return d; };
    const n = poly.length;

    // C3：最小 ΔE
    let C3 = null;
    if (slice) {
        const hp = sliceAtHue(points, H);
        if (hp) { const q = nearestOnPoly(hp, C, pt.l); if (q) C3 = make(q[1], q[0] * Math.cos(H), q[0] * Math.sin(H)); }
    } else {
        const q = nearestOnPoly(poly, pt.a, pt.b);
        if (q) C3 = make(Lc, q[0], q[1]);
    }

    // L 超出範圍但 a,b 已在截面內：只需調整 L
    if (inside) { const same = make(Lc, pt.a, pt.b); return { isInside: false, C1: same, C2: same, C3 }; }

    // C1：與半徑 C 的圓相交的邊，取色相角最接近者
    let C1 = null;
    if (C > 1e-6) {
        let bestAng = null, bestDiff = Infinity;
        for (let i = 0; i < n; i++) {
            const P = poly[i], Q = poly[(i + 1) % n];
            const dx = Q[0] - P[0], dy = Q[1] - P[1];
            const qa = dx * dx + dy * dy;
            const qb = 2 * (P[0] * dx + P[1] * dy);
            const qc = P[0] * P[0] + P[1] * P[1] - C * C;
            if (qa < 1e-12) continue;
            const disc = qb * qb - 4 * qa * qc;
            if (disc < 0) continue;
            const sq = Math.sqrt(disc);
            for (const t of [(-qb - sq) / (2 * qa), (-qb + sq) / (2 * qa)]) {
                if (t < -1e-9 || t > 1 + 1e-9) continue;
                const ang = Math.atan2(P[1] + t * dy, P[0] + t * dx);
                const diff = Math.abs(wrap(ang - H));
                if (diff < bestDiff) { bestDiff = diff; bestAng = ang; }
            }
        }
        if (bestAng !== null) C1 = make(Lc, C * Math.cos(bestAng), C * Math.sin(bestAng));
    }

    // C2：沿原色相的射線與截面相交，取半徑 ≤ C 的最大值
    let C2 = null;
    if (C > 1e-6) {
        const d = [Math.cos(H), Math.sin(H)];
        let rLo = 0, rHi = Infinity, empty = false;
        for (let i = 0; i < n; i++) {
            const P = poly[i], Q = poly[(i + 1) % n];
            const e = [Q[0] - P[0], Q[1] - P[1]];
            const ced = e[0] * d[1] - e[1] * d[0];
            const cep = e[0] * P[1] - e[1] * P[0];
            if (Math.abs(ced) < 1e-12) { if (-cep < -1e-9) empty = true; }
            else if (ced > 0) rLo = Math.max(rLo, cep / ced);
            else rHi = Math.min(rHi, cep / ced);
        }
        if (!empty && rLo <= rHi + 1e-9 && rLo < C) {
            const r = Math.min(C, rHi);
            C2 = make(Lc, r * d[0], r * d[1]);
        }
    }

    return { isInside: false, C1, C2, C3 };
}

export default {
    GAMUT_MODE, hull2D, insidePoly, nearestOnPoly, projectAB,
    lRange, sliceAtL, sliceAtHue, calculateCorrections,
};
