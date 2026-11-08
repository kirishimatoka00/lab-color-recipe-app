import test from 'node:test';
import assert from 'node:assert/strict';
import {
    hull2D, insidePoly, nearestOnPoly, projectAB, sliceAtL, calculateCorrections, GAMUT_MODE,
} from '../src/color/gamutUtils.js';

/** 造一個以 L 軸為中心、半徑隨 L 變化的「橄欖球」色域點雲 */
function olive(n = 4000) {
    const pts = [];
    let seed = 1234;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    for (let i = 0; i < n; i++) {
        const l = 10 + rnd() * 80;
        const rMax = 50 * Math.sin((Math.PI * (l - 10)) / 80); // 兩端收窄
        const r = Math.sqrt(rnd()) * rMax;
        const th = rnd() * Math.PI * 2;
        pts.push({ l, a: r * Math.cos(th), b: r * Math.sin(th) });
    }
    return pts;
}

test('凸包與內外判定', () => {
    const sq = hull2D([[0, 0], [1, 0], [1, 1], [0, 1], [0.5, 0.5]]);
    assert.equal(sq.length, 4, '內部點不該出現在凸包上');
    assert.ok(insidePoly(sq, 0.5, 0.5));
    assert.ok(!insidePoly(sq, 1.5, 0.5));
});

test('最近點落在邊界上', () => {
    const sq = hull2D([[0, 0], [2, 0], [2, 2], [0, 2]]);
    const q = nearestOnPoly(sq, 3, 1);
    assert.ok(Math.abs(q[0] - 2) < 1e-9 && Math.abs(q[1] - 1) < 1e-9);
});

test('等 L 截面反映色域在高亮處收窄', () => {
    const pts = olive();
    const mid = sliceAtL(pts, 50);
    const high = sliceAtL(pts, 85);
    assert.ok(mid && high);
    const span = (poly) => Math.max(...poly.map((p) => Math.hypot(p[0], p[1])));
    assert.ok(span(high) < span(mid) * 0.7, `高亮截面應明顯小：${span(high)} vs ${span(mid)}`);
});

test('投影模式：範圍內的點判定為 In Gamut', () => {
    const pts = olive();
    const r = calculateCorrections({ l: 50, a: 5, b: 5 }, pts, GAMUT_MODE.PROJECTION);
    assert.equal(r.isInside, true);
});

test('投影模式：範圍外的點給出 C1 / C2 / C3 且 C3 的 ΔE 最小', () => {
    const pts = olive();
    const out = { l: 50, a: 80, b: 10 };
    const r = calculateCorrections(out, pts, GAMUT_MODE.PROJECTION);
    assert.equal(r.isInside, false);
    assert.ok(r.C3, '必須有最小 ΔE 解');
    for (const key of ['C1', 'C2']) {
        if (r[key]) assert.ok(r.C3.dE <= r[key].dE + 1e-6, `${key} 的 ΔE 不該小於 C3`);
    }
    assert.ok(Math.abs(r.C3.dl) < 1e-9, '投影模式 ΔL 應為 0');
});

test('C2 維持色相、C1 維持彩度', () => {
    const pts = olive();
    const out = { l: 50, a: 70, b: 30 };
    const r = calculateCorrections(out, pts, GAMUT_MODE.PROJECTION);
    if (r.C2) assert.ok(Math.abs(r.C2.dH) < 1e-6, `C2 應維持色相，dH=${r.C2.dH}`);
    if (r.C1) assert.ok(Math.abs(r.C1.dC) < 1e-6, `C1 應維持彩度，dC=${r.C1.dC}`);
});

test('切面模式：L 超出色域範圍時先移到可用 L', () => {
    const pts = olive();
    const r = calculateCorrections({ l: 97, a: 2, b: 2 }, pts, GAMUT_MODE.SLICE);
    assert.equal(r.isInside, false);
    assert.ok(r.C3 && r.C3.l < 95, '應被拉回色域的 L 範圍內');
});

test('點雲不足時安全回傳 null', () => {
    assert.equal(calculateCorrections({ l: 50, a: 0, b: 0 }, [], GAMUT_MODE.PROJECTION), null);
    assert.equal(projectAB([{ l: 1, a: 1, b: 1 }]), null);
});
