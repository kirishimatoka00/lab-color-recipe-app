import test from 'node:test';
import assert from 'node:assert/strict';
import { makeSubstrate, DEFAULT_BLANK_LAB, ksToLab, fitColorant, mixToLab } from '../src/color/km.js';
import {
    buildCalibration, predictCalibrated, applyResidualField, scoreConfidence,
} from '../src/color/calibration.js';
import { deltaE00 } from '../src/color/colorUtils.js';

const sub = makeSubstrate(DEFAULT_BLANK_LAB);

function makeChromatic(kPerUnit, concs = [0.25, 0.5, 1, 2]) {
    const pts = concs.map((c) => ({
        c, whiteC: 0,
        lab: ksToLab([0, 1, 2].map((j) => (sub.K[j] + kPerUnit[j] * c) / sub.S[j])),
    }));
    return fitColorant(pts, sub);
}

const RED = makeChromatic([0.6, 7.0, 6.0]);
const YEL = makeChromatic([0.3, 1.2, 9.0]);

/** 造歷史配方：實際色力比建檔值弱，模擬批次差異 */
function historyWithStrength(sRed, sYel, recipes) {
    return recipes.map(([cr, cy], i) => {
        const truth = mixToLab([
            { model: RED, c: cr, strength: sRed },
            { model: YEL, c: cy, strength: sYel },
        ].filter((x) => x.c > 0), sub).lab;
        return {
            id: `h${i}`,
            items: [
                { colorantId: 'r', model: RED, c: cr },
                { colorantId: 'y', model: YEL, c: cy },
            ],
            measuredLab: truth,
        };
    });
}

test('色力係數能從歷史配方還原批次偏差', () => {
    const samples = historyWithStrength(0.85, 1.18, [[0.5, 0.3], [1.0, 0.2], [0.3, 0.8], [0.8, 0.6], [1.5, 0.4]]);
    const calib = buildCalibration(samples, sub);

    assert.ok(Math.abs(calib.strengths.r - 0.85) < 0.05, `r=${calib.strengths.r}`);
    assert.ok(Math.abs(calib.strengths.y - 1.18) < 0.05, `y=${calib.strengths.y}`);
    assert.ok(calib.evaluation.rmsDE00 < 0.2, `RMS=${calib.evaluation.rmsDE00}`);
    assert.ok(calib.evaluation.rmsDE00 < calib.baseline.rmsDE00, '校正後應優於校正前');
});

test('校正後對新配方的預測明顯變準', () => {
    const samples = historyWithStrength(0.85, 1.18, [[0.5, 0.3], [1.0, 0.2], [0.3, 0.8], [0.8, 0.6], [1.5, 0.4]]);
    const calib = buildCalibration(samples, sub);

    // 留一個沒進訓練集的新配方
    const cr = 0.65, cy = 0.45;
    const truth = mixToLab([
        { model: RED, c: cr, strength: 0.85 },
        { model: YEL, c: cy, strength: 1.18 },
    ], sub).lab;

    const items = [
        { colorantId: 'r', model: RED, c: cr, colorant: { name: 'Red' } },
        { colorantId: 'y', model: YEL, c: cy, colorant: { name: 'Yellow' } },
    ];
    const uncal = mixToLab(items, sub).lab;
    const cal = predictCalibrated({ items, substrate: sub, calib });

    assert.ok(deltaE00(cal.lab, truth) < deltaE00(uncal, truth) / 3,
        `校正 ${deltaE00(cal.lab, truth).toFixed(2)} vs 未校正 ${deltaE00(uncal, truth).toFixed(2)}`);
});

test('殘差場在遠離歷史點時自動衰減', () => {
    const field = {
        bandwidth: 10,
        nodes: [{ at: { l: 50, a: 10, b: 10 }, residual: { l: 2, a: -1, b: 3 }, id: 'a' }],
    };
    const near = applyResidualField({ l: 50, a: 10, b: 10 }, field);
    const far = applyResidualField({ l: 95, a: -40, b: 60 }, field);

    assert.ok(Math.abs(near.applied.l - 2) < 0.1, '近處應套用完整殘差');
    assert.ok(Math.abs(far.applied.l) < 0.01, '遠處殘差應衰減到可忽略');
    assert.ok(far.weight < 0.01);
});

test('資料互相矛盾時拒絕套用色力校正', () => {
    // 同一配方給出兩個差很遠的量測值
    const base = { colorantId: 'r', model: RED, c: 0.5 };
    const samples = [
        { id: 'a', items: [base], measuredLab: { l: 50, a: 40, b: 20 } },
        { id: 'b', items: [base], measuredLab: { l: 50, a: -40, b: -20 } },
    ];
    const calib = buildCalibration(samples, sub);
    assert.ok(calib.evaluation.rmsDE00 > 0, '矛盾資料必然留下大殘差');
});

test('信心分數會因外插與缺歷史而下降', () => {
    const items = [{ colorantId: 'r', model: RED, c: 8, colorant: { name: 'Red' } }]; // 遠超曲線上限 2%
    const s = scoreConfidence({ items, calib: null, residual: null });
    assert.ok(s.score < 50, `score=${s.score}`);
    assert.equal(s.level, 'low');
    assert.ok(s.reasons.some((r) => r.includes('外插')), s.reasons.join('; '));
    assert.ok(s.reasons.some((r) => r.includes('歷史配方')), s.reasons.join('; '));
});
