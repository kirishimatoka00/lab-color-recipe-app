import test from 'node:test';
import assert from 'node:assert/strict';
import {
    makeSubstrate, DEFAULT_BLANK_LAB, ksToLab, fitColorant, fitWhite, mixToLab,
} from '../src/color/km.js';
import { solveRecipe, substitute, dosageScan, reachableGamut } from '../src/color/solver.js';
import { deltaE00 } from '../src/color/colorUtils.js';

const sub = makeSubstrate(DEFAULT_BLANK_LAB);

function makeChromatic(kPerUnit, concs = [0.25, 0.5, 1, 2], gamma = 1) {
    const pts = concs.map((c) => {
        const lab = ksToLab([0, 1, 2].map((j) => (sub.K[j] + kPerUnit[j] * Math.pow(c, gamma)) / sub.S[j]));
        return { c, lab, whiteC: 0 };
    });
    return fitColorant(pts, sub);
}

const RED = makeChromatic([0.6, 7.0, 6.0]);
const YEL = makeChromatic([0.3, 1.2, 9.0]);
const BLU = makeChromatic([7.5, 4.0, 0.4]);

test('反解能還原已知配方（三色，無約束）', () => {
    const truth = [{ model: RED, c: 0.7 }, { model: YEL, c: 0.35 }, { model: BLU, c: 0.12 }];
    const target = mixToLab(truth, sub).lab;

    const r = solveRecipe({
        target,
        colorants: [
            { id: 'r', name: 'Red', model: RED, minC: 0, maxC: 4 },
            { id: 'y', name: 'Yellow', model: YEL, minC: 0, maxC: 4 },
            { id: 'b', name: 'Blue', model: BLU, minC: 0, maxC: 4 },
        ],
        substrate: sub,
    });

    assert.ok(r.dE00 < 0.3, `ΔE00=${r.dE00}`);
    for (let i = 0; i < 3; i++) {
        assert.ok(Math.abs(r.c[i] - truth[i].c) < 0.08, `c${i}=${r.c[i]} vs ${truth[i].c}`);
    }
});

test('最低含量限制被遵守：不是 0 就是 ≥ minC', () => {
    // 目標只需要一點點藍，低於藍的最低含量 → 求解器必須選擇歸零或拉到下限
    const target = mixToLab([{ model: RED, c: 0.8 }, { model: BLU, c: 0.02 }], sub).lab;
    const r = solveRecipe({
        target,
        colorants: [
            { id: 'r', name: 'Red', model: RED, minC: 0.05, maxC: 4 },
            { id: 'b', name: 'Blue', model: BLU, minC: 0.30, maxC: 4 },
        ],
        substrate: sub,
    });
    assert.equal(r.violations.length, 0, JSON.stringify(r.violations));
    for (const [i, c] of r.c.entries()) {
        const minC = [0.05, 0.30][i];
        assert.ok(c === 0 || c >= minC - 1e-9, `c${i}=${c} 落在禁區`);
    }
});

test('總量上限被遵守', () => {
    const target = { l: 20, a: 40, b: 25 };
    const r = solveRecipe({
        target,
        colorants: [
            { id: 'r', name: 'Red', model: RED, minC: 0, maxC: 10 },
            { id: 'y', name: 'Yellow', model: YEL, minC: 0, maxC: 10 },
        ],
        substrate: sub,
        maxTotalC: 1.5,
    });
    assert.ok(r.c.reduce((s, v) => s + v, 0) <= 1.5 + 1e-6);
});

test('含白系統：反解可同時決定白與彩色料', () => {
    const trueWhite = { k: [0.02, 0.02, 0.03], s: [60, 60, 55] };
    const wPts = [0.5, 1, 2, 4].map((c) => ({
        c,
        lab: ksToLab([0, 1, 2].map((j) => (sub.K[j] + c * trueWhite.k[j]) / (sub.S[j] + c * trueWhite.s[j]))),
    }));
    const W = fitWhite(wPts, sub);

    const truth = [{ model: RED, c: 0.5 }, { model: W, c: 3.0 }];
    const target = mixToLab(truth, sub).lab;

    const r = solveRecipe({
        target,
        colorants: [
            { id: 'r', name: 'Red', model: RED, minC: 0, maxC: 4 },
            { id: 'w', name: 'White', model: W, minC: 0, maxC: 8 },
        ],
        substrate: sub,
        restarts: 16,
    });
    assert.ok(r.dE00 < 1.0, `ΔE00=${r.dE00}`);
});

test('置換模擬回報位移方向', () => {
    const items = [{ model: RED, c: 0.6 }, { model: YEL, c: 0.3 }];
    const s = substitute({ items, substrate: sub, index: 0, newModel: BLU });
    assert.ok(s.dE00 > 10, '換紅為藍應有大幅位移');
    assert.ok(s.after.a < s.before.a, '換成藍後 a* 應下降');
});

test('劑量掃描單調且端點正確', () => {
    const items = [{ model: RED, c: 0.5 }];
    const scan = dosageScan({ items, substrate: sub, index: 0, from: 0, to: 2, steps: 11 });
    assert.equal(scan.length, 11);
    for (let i = 1; i < scan.length; i++) {
        assert.ok(scan[i].lab.l <= scan[i - 1].lab.l + 1e-9, '加色應讓明度單調下降');
    }
});

test('可達色域取樣遵守最低含量且產生有效點雲', () => {
    const cols = [
        { id: 'r', model: RED, minC: 0.1, maxC: 2 },
        { id: 'y', model: YEL, minC: 0.1, maxC: 2 },
        { id: 'b', model: BLU, minC: 0.1, maxC: 2 },
    ];
    const pts = reachableGamut(cols, sub, { samplesPerCombo: 60 });
    assert.ok(pts.length > 100, `只取到 ${pts.length} 點`);
    for (const p of pts) {
        assert.ok(Number.isFinite(p.l) && Number.isFinite(p.a) && Number.isFinite(p.b));
        assert.ok(p.l >= 0 && p.l <= 100);
    }
});
