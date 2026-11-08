/**
 * 色彩空間轉換工具
 * 由 lab-color-app 的 ColorUtils 移植，並補上精確的 XYZ→Lab 與 CIEDE2000。
 * 觀察者 2°，光源 D65。
 */

export const D65 = { X: 0.95047, Y: 1.0, Z: 1.08883 };

export const clamp = (v, min, max) => Math.min(Math.max(v, min), max);

/** Lab → XYZ（絕對值，Y 以 1.0 為白） */
export function labToXyz(l, a, b) {
    const y = (l + 16) / 116;
    const x = a / 500 + y;
    const z = y - b / 200;
    const pow3 = (v) => (v > 0.206893034 ? v * v * v : (v - 16 / 116) / 7.787);
    return [D65.X * pow3(x), D65.Y * pow3(y), D65.Z * pow3(z)];
}

/** XYZ → Lab */
export function xyzToLab(X, Y, Z) {
    const f = (t) => (t > 0.008856451679 ? Math.cbrt(t) : 7.787037 * t + 16 / 116);
    const fx = f(X / D65.X);
    const fy = f(Y / D65.Y);
    const fz = f(Z / D65.Z);
    return { l: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
}

export function xyzToRgbLinear(x, y, z) {
    return [
        x * 3.2406 + y * -1.5372 + z * -0.4986,
        x * -0.9689 + y * 1.8758 + z * 0.0415,
        x * 0.0557 + y * -0.204 + z * 1.057,
    ];
}

const gamma = (v) => (v > 0.0031308 ? 1.055 * Math.pow(v, 1 / 2.4) - 0.055 : 12.92 * v);

export function xyzToRgb(x, y, z) {
    const [rL, gL, bL] = xyzToRgbLinear(x, y, z);
    const R = Math.round(clamp(gamma(rL), 0, 1) * 255);
    const G = Math.round(clamp(gamma(gL), 0, 1) * 255);
    const B = Math.round(clamp(gamma(bL), 0, 1) * 255);
    return `rgb(${R}, ${G}, ${B})`;
}

export function labToRgbNormalized(l, a, b) {
    const [x, y, z] = labToXyz(l, a, b);
    const [rL, gL, bL] = xyzToRgbLinear(x, y, z);
    return [clamp(gamma(rL), 0, 1), clamp(gamma(gL), 0, 1), clamp(gamma(bL), 0, 1)];
}

export function labToHex(l, a, b) {
    const [x, y, z] = labToXyz(l, a, b);
    return xyzToRgb(x, y, z);
}

export function rgbToLab(r, g, b) {
    const inv = (v) => {
        const c = v / 255;
        return c > 0.04045 ? Math.pow((c + 0.055) / 1.055, 2.4) : c / 12.92;
    };
    const R = inv(r), G = inv(g), B = inv(b);
    const X = R * 0.4124 + G * 0.3576 + B * 0.1805;
    const Y = R * 0.2126 + G * 0.7152 + B * 0.0722;
    const Z = R * 0.0193 + G * 0.1192 + B * 0.9505;
    const lab = xyzToLab(X, Y, Z);
    return { l: round1(lab.l), a: round1(lab.a), b: round1(lab.b) };
}

const round1 = (v) => Math.round(v * 10) / 10;

/** CIE76 ΔE（沿用舊版行為，回傳數值） */
export function deltaE76(p1, p2) {
    const dL = p1.l - p2.l, da = p1.a - p2.a, db = p1.b - p2.b;
    return Math.sqrt(dL * dL + da * da + db * db);
}

/**
 * CIEDE2000 色差。反解最佳化以此為目標函數。
 * 參考 Sharma, Wu & Dalal (2005) 的實作，kL=kC=kH=1。
 */
export function deltaE00(p1, p2, kL = 1, kC = 1, kH = 1) {
    const rad = Math.PI / 180, deg = 180 / Math.PI;
    const L1 = p1.l, a1 = p1.a, b1 = p1.b;
    const L2 = p2.l, a2 = p2.a, b2 = p2.b;

    const C1 = Math.hypot(a1, b1);
    const C2 = Math.hypot(a2, b2);
    const Cbar = (C1 + C2) / 2;
    const Cbar7 = Math.pow(Cbar, 7);
    const G = 0.5 * (1 - Math.sqrt(Cbar7 / (Cbar7 + Math.pow(25, 7))));

    const a1p = (1 + G) * a1;
    const a2p = (1 + G) * a2;
    const C1p = Math.hypot(a1p, b1);
    const C2p = Math.hypot(a2p, b2);

    const hp = (bb, ap) => {
        if (ap === 0 && bb === 0) return 0;
        const h = Math.atan2(bb, ap) * deg;
        return h >= 0 ? h : h + 360;
    };
    const h1p = hp(b1, a1p);
    const h2p = hp(b2, a2p);

    const dLp = L2 - L1;
    const dCp = C2p - C1p;

    let dhp;
    if (C1p * C2p === 0) dhp = 0;
    else {
        dhp = h2p - h1p;
        if (dhp > 180) dhp -= 360;
        else if (dhp < -180) dhp += 360;
    }
    const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp / 2) * rad);

    const Lbarp = (L1 + L2) / 2;
    const Cbarp = (C1p + C2p) / 2;

    let hbarp;
    if (C1p * C2p === 0) hbarp = h1p + h2p;
    else {
        const diff = Math.abs(h1p - h2p);
        const sum = h1p + h2p;
        if (diff <= 180) hbarp = sum / 2;
        else hbarp = sum < 360 ? (sum + 360) / 2 : (sum - 360) / 2;
    }

    const T = 1
        - 0.17 * Math.cos((hbarp - 30) * rad)
        + 0.24 * Math.cos(2 * hbarp * rad)
        + 0.32 * Math.cos((3 * hbarp + 6) * rad)
        - 0.20 * Math.cos((4 * hbarp - 63) * rad);

    const dTheta = 30 * Math.exp(-Math.pow((hbarp - 275) / 25, 2));
    const Cbarp7 = Math.pow(Cbarp, 7);
    const RC = 2 * Math.sqrt(Cbarp7 / (Cbarp7 + Math.pow(25, 7)));
    const SL = 1 + (0.015 * Math.pow(Lbarp - 50, 2)) / Math.sqrt(20 + Math.pow(Lbarp - 50, 2));
    const SC = 1 + 0.045 * Cbarp;
    const SH = 1 + 0.015 * Cbarp * T;
    const RT = -Math.sin(2 * dTheta * rad) * RC;

    const tL = dLp / (kL * SL);
    const tC = dCp / (kC * SC);
    const tH = dHp / (kH * SH);

    return Math.sqrt(tL * tL + tC * tC + tH * tH + RT * tC * tH);
}

/** LCh 分量，報表用 */
export function labToLch(p) {
    const C = Math.hypot(p.a, p.b);
    let h = (Math.atan2(p.b, p.a) * 180) / Math.PI;
    if (h < 0) h += 360;
    return { L: p.l, C, h };
}

/** 兩點的 ΔL / Δa / Δb / ΔC / ΔH / ΔE00，沿用既有卡片的顯示欄位 */
export function colorDifference(sample, target) {
    const s = labToLch(sample), t = labToLch(target);
    const dL = sample.l - target.l;
    const da = sample.a - target.a;
    const db = sample.b - target.b;
    const dC = s.C - t.C;
    const dH2 = da * da + db * db - dC * dC;
    const dH = Math.sign(da * target.b - db * target.a || 1) * Math.sqrt(Math.max(0, dH2));
    return { dL, da, db, dC, dH, dE76: deltaE76(sample, target), dE00: deltaE00(sample, target) };
}

/** 與舊版相容的物件式匯出，方便移植既有元件 */
export const ColorUtils = {
    clamp, labToXyz, xyzToLab, xyzToRgbLinear, xyzToRgb,
    labToRgbNormalized, labToHex, rgbToLab, labToLch,
    calculateDeltaE: (p1, p2) => deltaE76(p1, p2).toFixed(2),
    deltaE76, deltaE00, colorDifference,
};

export default ColorUtils;
