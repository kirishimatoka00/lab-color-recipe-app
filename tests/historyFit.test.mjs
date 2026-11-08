import test from 'node:test';
import assert from 'node:assert/strict';
import { makeSubstrate, DEFAULT_BLANK_LAB, ksToLab, mixToLab, fitColorant } from '../src/color/km.js';
import { nnls, diagnoseDesign, fitFromHistory } from '../src/color/historyFit.js';
import { deltaE00 } from '../src/color/colorUtils.js';

const sub = makeSubstrate(DEFAULT_BLANK_LAB);

const TRUE_K = {
    red: [0.6, 7.0, 6.0],
    yellow: [0.3, 1.2, 9.0],
    blue: [7.5, 4.0, 0.4],
};

/** 由真實係數造一張歷史配方 */
function recipe(id, parts) {
    const K = [...sub.K];
    for (const [key, c] of Object.entries(parts)) {
        for (let j = 0; j < 3; j++) K[j] += TRUE_K[key][j] * c;
    }
    const lab = ksToLab([0, 1, 2].map((j) => K[j] / sub.S[j]));
    return {
        id,
        measuredLab: lab,
        items: Object.entries(parts).map(([key, c]) => ({ colorantId: key, c, model: null })),
    };
}

test('NNLS 解得出非負最小二乘且不給負解', () => {
    const A = [[1, 0], [0, 1], [1, 1]];
    const b = [2, 3, 5];
    const x = nnls(A, b);
    assert.ok(Math.abs(x[0] - 2) < 1e-6 && Math.abs(x[1] - 3) < 1e-6, `x=${x}`);

    // 真解為負時應被壓到 0
    const x2 = nnls([[1], [1]], [-3, -4]);
    assert.equal(x2[0], 0);
});

test('資料充足時能還原三支色料的真實吸收係數', () => {
    const samples = [
        recipe('a', { red: 0.8, yellow: 0.2 }),
        recipe('b', { red: 0.3, blue: 0.5 }),
        recipe('c', { yellow: 0.9, blue: 0.1 }),
        recipe('d', { red: 0.5, yellow: 0.5, blue: 0.5 }),
        recipe('e', { red: 1.2 }),
        recipe('f', { yellow: 1.5, blue: 0.3 }),
    ];
    const r = fitFromHistory({ samples, substrate: sub, unknownIds: ['red', 'yellow', 'blue'] });

    assert.equal(Object.keys(r.models).length, 3, r.warnings.join('; '));
    for (const key of ['red', 'yellow', 'blue']) {
        const got = r.models[key].kAt(1);
        for (let j = 0; j < 3; j++) {
            assert.ok(Math.abs(got[j] - TRUE_K[key][j]) < 0.05,
                `${key} ch${j}: ${got[j].toFixed(3)} vs ${TRUE_K[key][j]}`);
        }
    }
});

test('反推出的模型可用來預測新配方', () => {
    const samples = [
        recipe('a', { red: 0.8, yellow: 0.2 }),
        recipe('b', { red: 0.3, blue: 0.5 }),
        recipe('c', { yellow: 0.9, blue: 0.1 }),
        recipe('d', { red: 0.5, yellow: 0.5, blue: 0.5 }),
        recipe('e', { red: 1.2 }),
        recipe('f', { yellow: 1.5, blue: 0.3 }),
    ];
    const { models } = fitFromHistory({ samples, substrate: sub, unknownIds: ['red', 'yellow', 'blue'] });

    const truth = recipe('new', { red: 0.65, yellow: 0.4, blue: 0.15 }).measuredLab;
    const pred = mixToLab([
        { model: models.red, c: 0.65 },
        { model: models.yellow, c: 0.4 },
        { model: models.blue, c: 0.15 },
    ], sub).lab;

    assert.ok(deltaE00(pred, truth) < 0.3, `ΔE00=${deltaE00(pred, truth)}`);
});

test('兩支色料固定比例出現時被判定為共線而非硬給答案', () => {
    // red 與 yellow 永遠是 2:1，無法分離
    const samples = [
        recipe('a', { red: 0.8, yellow: 0.4 }),
        recipe('b', { red: 1.2, yellow: 0.6 }),
        recipe('c', { red: 0.4, yellow: 0.2 }),
        recipe('d', { red: 1.6, yellow: 0.8 }),
    ];
    const r = fitFromHistory({ samples, substrate: sub, unknownIds: ['red', 'yellow'] });

    assert.ok(r.warnings.some((w) => w.includes('連動')), r.warnings.join('; '));
    assert.equal(Object.keys(r.models).length, 0, '共線時不該產出模型');

    const diag = r.diagnostics;
    assert.ok(diag.every((d) => !d.usable));
});

test('只出現在一張配方裡的色料無法擬合', () => {
    const samples = [
        recipe('a', { red: 0.8, yellow: 0.3 }),
        recipe('b', { red: 0.5 }),
        recipe('c', { red: 1.0 }),
    ];
    const r = fitFromHistory({ samples, substrate: sub, unknownIds: ['red', 'yellow'] });
    assert.ok(r.models.red, '紅出現三次應可擬合');
    assert.ok(!r.models.yellow, '黃只出現一次不該產出模型');
    assert.ok(r.warnings.some((w) => w.includes('yellow')));
});

test('配方數少於未知色料數時明確標示欠定', () => {
    const samples = [
        recipe('a', { red: 0.8, yellow: 0.3, blue: 0.2 }),
        recipe('b', { red: 0.5, yellow: 0.6, blue: 0.4 }),
    ];
    const r = fitFromHistory({ samples, substrate: sub, unknownIds: ['red', 'yellow', 'blue'] });
    assert.ok(r.warnings.some((w) => w.includes('欠定')), r.warnings.join('; '));
});

test('已知模型的色料會被當成已知項扣除', () => {
    // 先用濃度曲線建好紅的模型
    const redCurve = [0.25, 0.5, 1, 2].map((c) => ({
        c, whiteC: 0,
        lab: ksToLab([0, 1, 2].map((j) => (sub.K[j] + TRUE_K.red[j] * c) / sub.S[j])),
    }));
    const redModel = fitColorant(redCurve, sub);

    // 歷史配方裡紅已知、藍未知，而且藍只跟紅一起出現
    const samples = [
        { ...recipe('a', { red: 0.8, blue: 0.3 }) },
        { ...recipe('b', { red: 0.8, blue: 0.6 }) },
        { ...recipe('c', { red: 0.8, blue: 0.9 }) },
    ].map((s) => ({
        ...s,
        items: s.items.map((it) => (it.colorantId === 'red' ? { ...it, model: redModel } : it)),
    }));

    const r = fitFromHistory({ samples, substrate: sub, unknownIds: ['blue'] });
    assert.ok(r.models.blue, r.warnings.join('; '));
    const got = r.models.blue.kAt(1);
    for (let j = 0; j < 3; j++) {
        assert.ok(Math.abs(got[j] - TRUE_K.blue[j]) < 0.08,
            `blue ch${j}: ${got[j].toFixed(3)} vs ${TRUE_K.blue[j]}`);
    }
});

test('設計矩陣診斷回報出現次數與共線比例', () => {
    const A = [[1, 0.5], [2, 1.0], [3, 1.5]];
    const d = diagnoseDesign(A, ['x', 'y']);
    assert.equal(d.length, 2);
    assert.ok(d.every((x) => !x.usable), '完全共線應全部標為不可用');
    assert.equal(d[0].appearances, 3);
});
