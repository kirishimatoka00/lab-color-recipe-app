/**
 * 範例資料。
 *
 * 曲線不是亂填的數字，而是用 KM 模型本身從一組假定的吸收係數算出來的，
 * 所以整組資料自洽：建模後能還原出原始係數，反解也會收斂。
 * 歷史配方刻意加上「色力偏差」與量測雜訊，讓校正層有東西可以校。
 */

import { makeSubstrate, ksToLab } from '../color/km.js';
import {
    makeResin, makeColorant, makeCurvePoint, makeFormulation,
    COLORANT_ROLE, COLORANT_TYPE, RECIPE_MODE,
} from './schema.js';
import { emptyDb } from './store.js';

const BLANK = { l: 92.4, a: -0.7, b: 2.6 };
const sub = makeSubstrate(BLANK);

/** 假定的「真實」參數 */
const WHITE = { k: [0.02, 0.02, 0.035], s: [58, 60, 52] };
const PIGMENTS = {
    red: { name: '紅 SPD (PR254)', k: [0.55, 7.2, 6.1], loading: 25, min: 0.02 },
    yellow: { name: '黃 SPD (PY180)', k: [0.28, 1.1, 9.4], loading: 30, min: 0.02 },
    blue: { name: '藍 SPD (PB15:3)', k: [7.8, 4.2, 0.35], loading: 20, min: 0.015 },
    black: { name: '黑 SPD (PBk7)', k: [22, 22, 22], loading: 40, min: 0.005 },
};

/** 以真實參數合成一點的 Lab；whiteC 為白顏料的有效濃度 */
function synth(kPerUnit, c, whiteC = 0) {
    const K = [0, 1, 2].map((j) => sub.K[j] + (kPerUnit ? kPerUnit[j] * c : 0) + whiteC * WHITE.k[j]);
    const S = [0, 1, 2].map((j) => sub.S[j] + whiteC * WHITE.s[j]);
    return round(ksToLab([0, 1, 2].map((j) => K[j] / S[j])));
}

/** 量測值只記到小數一位，跟儀器輸出一致 */
const round = (lab) => ({
    l: Math.round(lab.l * 10) / 10,
    a: Math.round(lab.a * 10) / 10,
    b: Math.round(lab.b * 10) / 10,
});

export function demoDb() {
    const base = makeResin({
        id: 'res_pp', name: 'PP 射出級', grade: 'H1500', mfi: 12,
        usage: 'base', blankLab: BLANK,
    });
    const carrier = makeResin({ id: 'res_pe', name: 'PE 載體', grade: 'LDPE', usage: 'carrier' });

    // --- 白：自己的曲線 ---
    const whiteDosages = [1, 2, 4, 8, 12];
    const whiteLoading = 50;
    const white = makeColorant({
        id: 'col_white', name: '白 SPD (TiO₂)', code: 'W-50',
        role: COLORANT_ROLE.WHITE, type: COLORANT_TYPE.SPD,
        pigmentLoading: whiteLoading, carrierId: 'res_pe', minFinalPct: 0.1,
        curve: whiteDosages.map((d) => makeCurvePoint({
            dosage: d, lab: synth(null, 0, (d * whiteLoading) / 100), resinId: 'res_pp',
            condition: '2mm 射出板 / SCI',
        })),
    });

    // --- 彩色料：曲線在白階 4% 色母（= 2% TiO₂）下量測，貼近實務 ---
    const whiteDosageForCurves = 4;
    const whiteC = (whiteDosageForCurves * whiteLoading) / 100;

    const colorants = Object.entries(PIGMENTS).map(([key, p]) => {
        const dosages = [0.5, 1, 2, 4, 8];
        return makeColorant({
            id: `col_${key}`, name: p.name, type: COLORANT_TYPE.SPD,
            role: COLORANT_ROLE.CHROMATIC, pigmentLoading: p.loading,
            carrierId: 'res_pe', minFinalPct: p.min,
            additives: [{ type: 'wax', name: 'PE wax', pct: 2 }],
            curve: dosages.map((d) => makeCurvePoint({
                dosage: d,
                whiteDosage: whiteDosageForCurves,
                whiteColorantId: 'col_white',
                lab: synth(p.k, (d * p.loading) / 100, whiteC),
                resinId: 'res_pp',
                condition: '2mm 射出板 / SCI',
            })),
        });
    });

    // --- 歷史配方：實際色力與建檔值有落差，另加量測雜訊 ---
    const strengthBias = { red: 0.88, yellow: 1.14, blue: 0.95, black: 1.0, white: 1.0 };
    let seed = 424242;
    const noise = () => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        return (seed / 0x7fffffff - 0.5) * 0.4; // ±0.2 單位
    };

    const recipes = [
        { name: '淺粉 A', parts: { red: 1.2, white: 6 } },
        { name: '米色 B', parts: { yellow: 1.5, red: 0.4, white: 8 } },
        { name: '天藍 C', parts: { blue: 2.0, white: 5 } },
        { name: '橄欖綠 D', parts: { yellow: 3.0, blue: 1.2, white: 3 } },
        { name: '深灰 E', parts: { black: 0.8, white: 2 } },
        { name: '磚紅 F', parts: { red: 4.0, yellow: 1.0, black: 0.2, white: 2 } },
    ];

    const byId = Object.fromEntries([...colorants, white].map((c) => [c.id, c]));

    const formulations = recipes.map((r, i) => {
        const K = [...sub.K], S = [...sub.S];
        for (const [key, dosage] of Object.entries(r.parts)) {
            const col = byId[`col_${key}`];
            const c = (dosage * col.pigmentLoading) / 100;
            const bias = strengthBias[key] ?? 1;
            if (key === 'white') {
                for (let j = 0; j < 3; j++) { K[j] += c * WHITE.k[j] * bias; S[j] += c * WHITE.s[j] * bias; }
            } else {
                for (let j = 0; j < 3; j++) K[j] += PIGMENTS[key].k[j] * c * bias;
            }
        }
        const lab = ksToLab([0, 1, 2].map((j) => K[j] / S[j]));
        return makeFormulation({
            id: `rec_${i}`, name: r.name,
            date: `2026-0${(i % 9) + 1}-1${i}`,
            mode: RECIPE_MODE.DIRECT,
            baseResinId: 'res_pp', carrierId: 'res_pe',
            condition: '2mm 射出板 / SCI',
            status: i < 4 ? '量產' : '試打',
            components: Object.entries(r.parts).map(([key, dosage]) => ({
                colorantId: `col_${key}`, value: dosage,
            })),
            measuredLab: round({ l: lab.l + noise(), a: lab.a + noise(), b: lab.b + noise() }),
        });
    });

    return {
        ...emptyDb(),
        resins: [base, carrier],
        colorants: [white, ...colorants],
        formulations,
        settings: {
            ...emptyDb().settings,
            baseResinId: 'res_pp',
            carrierId: 'res_pe',
            condition: '2mm 射出板 / SCI',
            deltaEThreshold: 1.0,
        },
    };
}

export default demoDb;
