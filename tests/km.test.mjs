import test from 'node:test';
import assert from 'node:assert/strict';
import {
    labToKS, ksToLab, makeSubstrate, DEFAULT_BLANK_LAB,
    fitColorant, fitWhite, mixToLab, chooseFitForm, FIT_FORM,
} from '../src/color/km.js';
import { deltaE00, deltaE76 } from '../src/color/colorUtils.js';

const sub = makeSubstrate(DEFAULT_BLANK_LAB);

/** 用「真實」參數造一條濃度曲線，再看擬合能不能還原 */
function synthChromatic(kPerUnit, concs, whiteC = 0, white = null, gamma = 1) {
    return concs.map((c) => {
        const K = [0, 1, 2].map((j) => sub.K[j] + kPerUnit[j] * Math.pow(c, gamma) + (white ? whiteC * white.k[j] : 0));
        const S = [0, 1, 2].map((j) => sub.S[j] + (white ? whiteC * white.s[j] : 0));
        const lab = ksToLab([0, 1, 2].map((j) => K[j] / S[j]));
        return { c, lab, whiteC };
    });
}

test('Lab ↔ K/S 往返無失真', () => {
    for (const lab of [{ l: 50, a: 20, b: -30 }, { l: 88, a: -4, b: 12 }, { l: 12, a: 1, b: -2 }]) {
        const back = ksToLab(labToKS(lab));
        assert.ok(deltaE76(back, lab) < 0.01, `ΔE=${deltaE76(back, lab)}`);
    }
});

test('三點線性擬合可還原真實吸收係數並外插', () => {
    const trueK = [2.0, 4.5, 0.8];
    const pts = synthChromatic(trueK, [0.5, 1.0, 2.0]);
    const m = fitColorant(pts, sub);
    assert.equal(m.form, FIT_FORM.LINEAR);
    for (let j = 0; j < 3; j++) {
        assert.ok(Math.abs(m.channels[j].params.alpha - trueK[j]) < 1e-6);
    }
    // 外插到 3.0% 要與理論值一致
    const pred = mixToLab([{ model: m, c: 3.0 }], sub);
    const truth = synthChromatic(trueK, [3.0])[0].lab;
    assert.ok(deltaE00(pred.lab, truth) < 0.05);
});

test('冪次擬合能抓到非線性飽和（4–6 點）', () => {
    const trueK = [3.0, 1.2, 5.0];
    const gamma = 0.7;
    const pts = synthChromatic(trueK, [0.25, 0.5, 1, 2, 4], 0, null, gamma);
    const m = fitColorant(pts, sub);
    assert.equal(m.form, FIT_FORM.POWER);
    for (let j = 0; j < 3; j++) {
        assert.ok(Math.abs(m.channels[j].params.gamma - gamma) < 0.08,
            `ch${j} gamma=${m.channels[j].params.gamma}`);
    }
});

test('12 點走 PCHIP，量測點上幾乎零誤差', () => {
    const trueK = [1.5, 3.0, 0.5];
    const concs = Array.from({ length: 12 }, (_, i) => 0.2 + i * 0.3);
    const pts = synthChromatic(trueK, concs, 0, null, 0.85);
    const m = fitColorant(pts, sub);
    assert.equal(m.form, FIT_FORM.PCHIP);
    for (const p of pts) {
        const pred = mixToLab([{ model: m, c: p.c }], sub);
        assert.ok(deltaE00(pred.lab, p.lab) < 0.05);
    }
});

test('白的 k/s 可由自身曲線擬合，且混色遵守白還原', () => {
    const trueWhite = { k: [0.02, 0.02, 0.03], s: [60, 60, 55] };
    const wPts = [0.5, 1, 2, 4].map((c) => {
        const lab = ksToLab([0, 1, 2].map((j) =>
            (sub.K[j] + c * trueWhite.k[j]) / (sub.S[j] + c * trueWhite.s[j])));
        return { c, lab };
    });
    const w = fitWhite(wPts, sub);
    for (const p of wPts) {
        const pred = mixToLab([{ model: w, c: p.c }], sub);
        assert.ok(deltaE00(pred.lab, p.lab) < 0.3, `white ΔE=${deltaE00(pred.lab, p.lab)}`);
    }

    // 彩色料的曲線在白階 2% 下量測，還原後換到白階 4% 應與理論一致
    const trueK = [4.0, 1.0, 6.0];
    const cPts = synthChromatic(trueK, [0.3, 0.6, 1.2], 2, trueWhite);
    const m = fitColorant(cPts, sub, w);
    const pred = mixToLab([{ model: m, c: 0.9 }, { model: w, c: 4 }], sub);
    const K = [0, 1, 2].map((j) => sub.K[j] + trueK[j] * 0.9 + 4 * trueWhite.k[j]);
    const S = [0, 1, 2].map((j) => sub.S[j] + 4 * trueWhite.s[j]);
    const truth = ksToLab([0, 1, 2].map((j) => K[j] / S[j]));
    assert.ok(deltaE00(pred.lab, truth) < 0.5, `cross-white ΔE=${deltaE00(pred.lab, truth)}`);
});

test('擬合形式依點數切換', () => {
    assert.equal(chooseFitForm(3), FIT_FORM.LINEAR);
    assert.equal(chooseFitForm(5), FIT_FORM.POWER);
    assert.equal(chooseFitForm(12), FIT_FORM.PCHIP);
});
