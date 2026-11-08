import React from 'react';
import {
    Card, Button, Field, NumberInput, Select, TextInput, LabInput, Swatch,
    ConfidenceBadge, DeltaEBadge, Empty, Warnings, Tabs, fmt,
} from '../components/ui.jsx';
import LabPlot from '../components/LabPlot.jsx';
import Lab3D from '../components/Lab3D.jsx';
import CandidatesPanel from '../components/CandidatesPanel.jsx';
import CorrectionPanel from '../components/CorrectionPanel.jsx';
import HistoryStartPanel from '../components/HistoryStartPanel.jsx';
import PickInspector from '../components/PickInspector.jsx';
import { solveRecipe, dosageScan, substitute, reachableGamut } from '../color/solver.js';
import { buildSolverColorants } from '../color/engine.js';
import { predictCalibrated } from '../color/calibration.js';
import { calculateCorrections, GAMUT_MODE } from '../color/gamutUtils.js';
import { colorDifference } from '../color/colorUtils.js';
import { cToDosage, backoutMasterbatch, RECIPE_MODE, COLORANT_ROLE } from '../data/schema.js';

/**
 * 配方工作台：反解目標色、檢視預測落點、做置換與劑量模擬。
 */
export default function RecipeView({ db, compiled, settings, onSettings }) {
    const [target, setTarget] = React.useState({ l: 55, a: 28, b: -12 });
    const [selected, setSelected] = React.useState([]);
    const [maxTotalC, setMaxTotalC] = React.useState('');
    const [mode, setMode] = React.useState(RECIPE_MODE.DIRECT);
    const [letdown, setLetdown] = React.useState(4);
    const [solution, setSolution] = React.useState(null);
    const [manual, setManual] = React.useState(null);  // 手動微調後的濃度
    const [plotTab, setPlotTab] = React.useState('ab');
    const [gamut, setGamut] = React.useState([]);
    const [busy, setBusy] = React.useState(false);
    const [scanIdx, setScanIdx] = React.useState(null);
    // 從歷史配方帶入時，色料清單要先換掉，濃度才對得上欄位順序
    const [pendingLoad, setPendingLoad] = React.useState(null);
    const [pick, setPick] = React.useState(null);
    const [plotBig, setPlotBig] = React.useState(false);

    const usable = (db.colorants || []).filter((c) => compiled.models[c.id]);
    const solverCols = React.useMemo(
        () => buildSolverColorants(selected, compiled),
        [selected, compiled],
    );

    const toggle = (id) =>
        setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

    /** 帶入一組 {colorantId: 有效濃度}：先換選取清單，等 solverCols 更新後再填濃度 */
    const loadConcentrations = (byId) => {
        setSelected(Object.keys(byId));
        setPendingLoad(byId);
    };

    React.useEffect(() => {
        if (!pendingLoad) return;
        const ids = Object.keys(pendingLoad);
        // 等 solverCols 真的換成這組色料了才填，否則濃度會對到錯的欄位
        if (solverCols.length !== ids.length) return;
        if (!ids.every((id) => solverCols.some((c) => c.id === id))) return;

        const next = solverCols.map((c) => pendingLoad[c.id] ?? 0);
        setSolution({
            c: next, lab: null, dE00: null, diff: null, violations: [], inRange: [],
        });
        setManual(next);
        setGamut(reachableGamut(solverCols, compiled.substrate, { samplesPerCombo: 150 }));
        setPendingLoad(null);
    }, [pendingLoad, solverCols, compiled]);

    /* ---------------- 反解 ---------------- */
    const run = () => {
        if (!solverCols.length) return;
        setBusy(true);
        // 讓瀏覽器先把 busy 狀態畫出來再算，否則按鈕看起來沒反應
        setTimeout(() => {
            try {
                const r = solveRecipe({
                    target, colorants: solverCols, substrate: compiled.substrate,
                    maxTotalC: maxTotalC === '' ? null : Number(maxTotalC),
                    restarts: 16,
                });
                setSolution(r);
                setManual(r ? r.c.slice() : null);
                setGamut(reachableGamut(solverCols, compiled.substrate, { samplesPerCombo: 150 }));
            } finally {
                setBusy(false);
            }
        }, 10);
    };

    /* ---------------- 目前濃度（反解結果或手動微調） ---------------- */
    const current = manual || (solution ? solution.c : null);

    const live = React.useMemo(() => {
        if (!current || !solverCols.length) return null;
        const items = solverCols.map((col, i) => ({
            colorantId: col.id, colorant: col.colorant, model: col.model, c: current[i],
        }));
        const p = predictCalibrated({
            items, substrate: compiled.substrate, calib: compiled.calib,
            sameCarrier: true, hasBlank: compiled.hasBlank,
        });
        return { ...p, items, diff: colorDifference(p.lab, target) };
    }, [current, solverCols, compiled, target]);

    const corrections = React.useMemo(
        () => (gamut.length >= 3 ? calculateCorrections(target, gamut, GAMUT_MODE.PROJECTION) : null),
        [gamut, target],
    );

    const violations = React.useMemo(() => {
        if (!current) return [];
        const out = [];
        current.forEach((c, i) => {
            const col = solverCols[i];
            if (c > 1e-9 && col.minC > 0 && c < col.minC - 1e-9) {
                out.push(`${col.name}：有效濃度 ${fmt(c)}% 低於最低含量 ${fmt(col.minC)}%`);
            }
            if (col.maxC && c > col.maxC + 1e-9) {
                out.push(`${col.name}：有效濃度 ${fmt(c)}% 超過上限 ${fmt(col.maxC)}%`);
            }
        });
        return out;
    }, [current, solverCols]);

    /* ---------------- 母粒反推 ---------------- */
    const mbPlan = React.useMemo(() => {
        if (!current || mode !== RECIPE_MODE.MASTERBATCH) return null;
        const targets = solverCols
            .map((col, i) => ({ colorantId: col.id, c: current[i] }))
            .filter((t) => t.c > 0);
        return backoutMasterbatch(targets, letdown, compiled.colorantsById);
    }, [current, mode, letdown, solverCols, compiled]);

    /* ---------------- 劑量掃描 ---------------- */
    const scan = React.useMemo(() => {
        if (scanIdx == null || !current) return null;
        const items = solverCols.map((col, i) => ({ model: col.model, c: current[i], strength: col.strength }));
        const col = solverCols[scanIdx];
        const hi = Math.max(current[scanIdx] * 2, col.model?.cRange?.[1] ?? 1);
        return dosageScan({ items, substrate: compiled.substrate, index: scanIdx, from: 0, to: hi, steps: 25 });
    }, [scanIdx, current, solverCols, compiled]);

    return (
        <div className="grid h-full grid-cols-1 gap-3 overflow-auto p-3 xl:grid-cols-[290px_minmax(0,1fr)_minmax(460px,0.95fr)] lg:grid-cols-[260px_minmax(0,1fr)]">

            {/* ---------- 左欄：目標與色料 ---------- */}
            <div className="space-y-3">
                <Card title="目標色">
                    <LabInput lab={target} onChange={setTarget} />
                    <div className="mt-2 text-[11px] text-faint">
                        也可以從歷史配方頁把實測色帶過來當目標。
                    </div>
                </Card>

                <Card title={`可用色料（已選 ${selected.length}）`}
                    right={<Button variant="ghost" onClick={() => setSelected([])}>清除</Button>}>
                    {usable.length === 0 ? (
                        <Empty>還沒有建好濃度曲線的色料。請先到「色料資料庫」建檔。</Empty>
                    ) : (
                        <div className="max-h-72 space-y-1 overflow-auto">
                            {usable.map((c) => {
                                const m = compiled.models[c.id];
                                const on = selected.includes(c.id);
                                return (
                                    <button
                                        key={c.id}
                                        onClick={() => toggle(c.id)}
                                        className={`flex w-full items-center gap-2 rounded-md border px-2 py-1.5 text-left transition-colors ${
                                            on ? 'accent-edge accent-soft' : 'border-base hover-row'}`}
                                    >
                                        <input type="checkbox" readOnly checked={on} className="pointer-events-none" />
                                        <Swatch lab={c.curve?.[Math.floor(c.curve.length / 2)]?.lab} size={18} />
                                        <span className="min-w-0 flex-1 truncate text-xs font-medium text-sub">
                                            {c.name || '(未命名)'}
                                            {c.role === COLORANT_ROLE.WHITE && <span className="ml-1 text-[10px] text-faint">白</span>}
                                        </span>
                                        <span className="shrink-0 font-mono text-[10px] text-faint">
                                            {m?.cRange ? `${fmt(m.cRange[0], 2)}–${fmt(m.cRange[1], 2)}%` : ''}
                                        </span>
                                    </button>
                                );
                            })}
                        </div>
                    )}
                </Card>

                <Card title="限制與輸出形式">
                    <div className="space-y-2">
                        <Field label="顏料總量上限 (wt%)" hint="留空表示不限">
                            <NumberInput value={maxTotalC} onChange={setMaxTotalC} placeholder="例如 3" />
                        </Field>
                        <Field label="配方形式">
                            <Select value={mode} onChange={(e) => setMode(e.target.value)}>
                                <option value={RECIPE_MODE.DIRECT}>色母直接加入基礎樹酯</option>
                                <option value={RECIPE_MODE.MASTERBATCH}>先做複合母粒再 letdown</option>
                            </Select>
                        </Field>
                        {mode === RECIPE_MODE.MASTERBATCH && (
                            <Field label="母粒添加量 letdown (wt%)">
                                <NumberInput value={letdown} onChange={setLetdown} />
                            </Field>
                        )}
                    </div>
                    <Button variant="primary" onClick={run} disabled={!selected.length || busy}
                        className="mt-3 w-full py-2 text-sm">
                        {busy ? '計算中…' : '反解配方'}
                    </Button>
                </Card>
            </div>

            {/* ---------- 中欄：結果 ---------- */}
            <div className="space-y-3">
                <HistoryStartPanel
                    target={target} compiled={compiled}
                    threshold={settings.deltaEThreshold ?? 1}
                    onLoad={loadConcentrations}
                />

                {!solution ? (
                    <Card title="配方結果">
                        <Empty>
                            選好色料後按「反解配方」，或從上方挑一張接近的歷史配方當起點。<br />
                            程式會在最低含量限制下，找出最接近目標色的濃度組合。
                        </Empty>
                    </Card>
                ) : (
                    <>
                        <Card
                            title="配方結果"
                            right={live && (
                                <div className="flex items-center gap-2">
                                    <DeltaEBadge value={live.diff.dE00} threshold={settings.deltaEThreshold ?? 1} />
                                    <ConfidenceBadge confidence={live.confidence} />
                                </div>
                            )}
                        >
                            <div className="mb-3 flex items-center gap-3">
                                <div className="text-center">
                                    <Swatch lab={target} size={44} />
                                    <div className="mt-1 text-[10px] text-muted">目標</div>
                                </div>
                                <div className="text-center">
                                    <Swatch lab={live?.lab} size={44} />
                                    <div className="mt-1 text-[10px] text-muted">預測</div>
                                </div>
                                {live && (
                                    <dl className="grid flex-1 grid-cols-3 gap-x-3 gap-y-1 font-mono text-[11px]">
                                        {[['ΔL*', live.diff.dL], ['Δa*', live.diff.da], ['Δb*', live.diff.db],
                                          ['ΔC*', live.diff.dC], ['ΔH*', live.diff.dH], ['ΔE₇₆', live.diff.dE76]].map(([k, v]) => (
                                            <div key={k} className="flex justify-between">
                                                <dt className="text-faint">{k}</dt>
                                                <dd className="text-sub">{v >= 0 ? '+' : ''}{v.toFixed(2)}</dd>
                                            </div>
                                        ))}
                                    </dl>
                                )}
                            </div>

                            <table className="w-full text-xs">
                                <thead>
                                    <tr className="border-b border-base text-left text-[10px] uppercase tracking-wide text-faint">
                                        <th className="py-1">色料</th>
                                        <th className="py-1 text-right">顏料濃度 wt%</th>
                                        <th className="py-1 text-right">色母添加 wt%</th>
                                        <th className="py-1 text-right">最低含量</th>
                                        <th className="py-1 text-center">範圍</th>
                                        <th className="py-1" />
                                    </tr>
                                </thead>
                                <tbody>
                                    {solverCols.map((col, i) => {
                                        const c = current[i];
                                        const inRange = c <= 0 || (col.model.cRange
                                            && c >= col.model.cRange[0] - 1e-9 && c <= col.model.cRange[1] + 1e-9);
                                        return (
                                            <tr key={col.id} className="border-b border-slate-100 last:border-0">
                                                <td className="py-1.5">
                                                    <div className="flex items-center gap-1.5">
                                                        <Swatch lab={col.colorant?.curve?.[0]?.lab} size={14} />
                                                        <span className={c > 0 ? 'text-sub' : 'text-ghost'}>{col.name}</span>
                                                    </div>
                                                </td>
                                                <td className="py-1.5 text-right">
                                                    <NumberInput
                                                        value={Math.round(c * 10000) / 10000}
                                                        onChange={(v) => setManual((m) => {
                                                            const n = (m || solution.c).slice(); n[i] = Math.max(0, v); return n;
                                                        })}
                                                        className="w-24 py-0.5 text-right font-mono text-[11px]"
                                                    />
                                                </td>
                                                <td className="py-1.5 text-right font-mono text-sub">
                                                    {c > 0 ? fmt(cToDosage(c, col.colorant), 3) : '—'}
                                                </td>
                                                <td className="py-1.5 text-right font-mono text-faint">
                                                    {col.minC > 0 ? fmt(col.minC) : '—'}
                                                </td>
                                                <td className="py-1.5 text-center">
                                                    {c <= 0 ? <span className="text-ghost">未用</span>
                                                        : inRange ? <span className="text-good">內插</span>
                                                            : <span className="text-warn">外插</span>}
                                                </td>
                                                <td className="py-1.5 text-right">
                                                    <Button variant="ghost"
                                                        onClick={() => setScanIdx(scanIdx === i ? null : i)}>
                                                        {scanIdx === i ? '收起' : '掃描'}
                                                    </Button>
                                                </td>
                                            </tr>
                                        );
                                    })}
                                </tbody>
                                <tfoot>
                                    <tr className="border-t border-strong font-medium">
                                        <td className="py-1.5 text-muted">合計</td>
                                        <td className="py-1.5 text-right font-mono text-sub">
                                            {fmt(current.reduce((s, v) => s + v, 0))}
                                        </td>
                                        <td className="py-1.5 text-right font-mono text-sub">
                                            {fmt(current.reduce((s, v, i) => s + (v > 0 ? cToDosage(v, solverCols[i].colorant) : 0), 0))}
                                        </td>
                                        <td colSpan={3} />
                                    </tr>
                                </tfoot>
                            </table>

                            {manual && solution && manual.some((v, i) => Math.abs(v - solution.c[i]) > 1e-9) && (
                                <Button className="mt-2" onClick={() => setManual(solution.c.slice())}>
                                    還原成反解結果
                                </Button>
                            )}

                            {violations.length > 0 && (
                                <div className="mt-2">
                                    <Warnings items={violations} />
                                </div>
                            )}
                            {live?.confidence?.reasons?.length > 0 && (
                                <ul className="mt-2 space-y-0.5 text-[11px] text-muted">
                                    {live.confidence.reasons.map((r, i) => <li key={i}>· {r}</li>)}
                                </ul>
                            )}
                        </Card>

                        {mbPlan && (
                            <Card title={`母粒組成（letdown ${letdown}%）`}>
                                {!mbPlan.feasible && (
                                    <div className="mb-2 rounded-md border tone-bad p-2 text-[11px]">
                                        各成分加起來超過 100%，這個 letdown 太低。請提高 letdown 或改用含量更高的色母。
                                    </div>
                                )}
                                <table className="w-full text-xs">
                                    <tbody>
                                        {mbPlan.components.map((c) => (
                                            <tr key={c.colorantId} className="border-b border-slate-100">
                                                <td className="py-1 text-sub">
                                                    {compiled.colorantsById[c.colorantId]?.name}
                                                </td>
                                                <td className="py-1 text-right font-mono text-sub">{fmt(c.value)} %</td>
                                            </tr>
                                        ))}
                                        <tr>
                                            <td className="py-1 text-muted">載體樹酯</td>
                                            <td className={`py-1 text-right font-mono ${mbPlan.carrierPct < 0 ? 'text-bad' : 'text-muted'}`}>
                                                {fmt(mbPlan.carrierPct)} %
                                            </td>
                                        </tr>
                                    </tbody>
                                </table>
                            </Card>
                        )}

                        {scan && (
                            <Card title={`劑量掃描：${solverCols[scanIdx].name}`}>
                                <ScanChart scan={scan} current={current[scanIdx]} target={target} />
                            </Card>
                        )}

                        <CandidatesPanel
                            target={target} solverCols={solverCols} compiled={compiled}
                            maxTotalC={maxTotalC === '' ? null : Number(maxTotalC)}
                            threshold={settings.deltaEThreshold ?? 1}
                            onApply={(c) => setManual(c.slice())}
                        />

                        <CorrectionPanel
                            solverCols={solverCols} current={current} compiled={compiled}
                            target={target} threshold={settings.deltaEThreshold ?? 1}
                            onApply={(c) => setManual(c.slice())}
                        />

                        <SubstitutionPanel
                            solverCols={solverCols} current={current} compiled={compiled}
                            usable={usable} target={target}
                        />
                    </>
                )}
            </div>

            {/* ---------- 右欄：色度圖 ---------- */}
            <div className={`space-y-3 ${plotBig ? 'xl:col-span-3' : ''}`}>
                <Card
                    title="色度圖"
                    right={
                        <div className="flex items-center gap-2">
                            <Tabs value={plotTab} onChange={setPlotTab}
                                tabs={[{ id: 'ab', label: 'a*–b*' }, { id: 'lc', label: 'C*–L*' }, { id: '3d', label: '3D' }]} />
                            <Button onClick={() => setPlotBig((v) => !v)}>
                                {plotBig ? '縮小' : '放大'}
                            </Button>
                        </div>
                    }
                >
                    <div className={plotBig ? 'mx-auto max-w-[760px]' : ''}>
                        {plotTab === '3d' ? (
                            <Lab3D
                                gamutPoints={gamut}
                                target={target}
                                predicted={live?.lab}
                                corrections={corrections && !corrections.isInside ? corrections : null}
                                height={plotBig ? 640 : 470}
                                onPick={setPick}
                            />
                        ) : (
                            <LabPlot
                                mode={plotTab}
                                gamutPoints={gamut}
                                target={target}
                                predicted={live?.lab}
                                corrections={corrections && !corrections.isInside ? corrections : null}
                                size={plotBig ? 640 : 470}
                                onPick={setPick}
                            />
                        )}
                    </div>

                    {pick && (
                        <div className="mt-2">
                            <PickInspector
                                pick={pick} solverCols={solverCols} target={target}
                                onApply={(c) => { setManual(c); setPick(null); }}
                                onClose={() => setPick(null)}
                            />
                        </div>
                    )}

                    {gamut.length > 0 && !pick && (
                        <div className="mt-2 text-[11px] text-muted">
                            {corrections?.isInside
                                ? '目標色在這組色料的可達範圍內。'
                                : '目標色超出可達範圍，虛線為三種修正建議的落點。'}
                            <span className="ml-1 text-faint">
                                {plotTab === '3d' ? '點色域上的取樣點可看配方。' : '點圖上任一處可查最接近的取樣配方。'}
                            </span>
                        </div>
                    )}
                </Card>

                {corrections && !corrections.isInside && (
                    <Card title="色域修正建議">
                        <CorrectionTable corrections={corrections} />
                    </Card>
                )}
            </div>
        </div>
    );
}

/* ------------------------------------------------------------------ */

function ScanChart({ scan, current }) {
    const W = 340, H = 140, P = 28;
    const cs = scan.map((s) => s.c);
    const x0 = Math.min(...cs), x1 = Math.max(...cs);
    const es = scan.map((s) => s.dE00FromBase);
    const y1 = Math.max(...es, 1);
    const sx = (v) => P + ((v - x0) / (x1 - x0 || 1)) * (W - P * 2);
    const sy = (v) => H - 20 - (v / y1) * (H - 40);
    const path = scan.map((s, i) => `${i ? 'L' : 'M'}${sx(s.c).toFixed(1)},${sy(s.dE00FromBase).toFixed(1)}`).join(' ');

    return (
        <>
            <svg viewBox={`0 0 ${W} ${H}`} className="w-full">
                <line x1={P} y1={H - 20} x2={W - P} y2={H - 20} stroke="#cbd5e1" />
                <path d={path} fill="none" stroke="#3b82f6" strokeWidth="1.5" />
                <line x1={sx(current)} y1={10} x2={sx(current)} y2={H - 20} stroke="#dc2626" strokeDasharray="3 2" />
                <text x={sx(current)} y={8} fontSize="8" fill="#dc2626" textAnchor="middle">目前 {fmt(current)}%</text>
                <text x={W / 2} y={H - 4} fontSize="8" fill="#94a3b8" textAnchor="middle">顏料濃度 wt%</text>
                <text x={6} y={14} fontSize="8" fill="#94a3b8">ΔE₀₀（相對目前配方）</text>
            </svg>
            <div className="grid grid-cols-3 gap-2 text-[11px]">
                {[0.25, 0.5, 0.75].map((f) => {
                    const idx = Math.round(f * (scan.length - 1));
                    const s = scan[idx];
                    return (
                        <div key={f} className="rounded border border-base p-1.5">
                            <div className="font-mono text-sub">{fmt(s.c)}%</div>
                            <div className="text-faint">L {s.lab.l.toFixed(1)} a {s.lab.a.toFixed(1)} b {s.lab.b.toFixed(1)}</div>
                        </div>
                    );
                })}
            </div>
        </>
    );
}

function CorrectionTable({ corrections }) {
    const rows = [
        ['C1', '維持彩度、調整色相', corrections.C1],
        ['C2', '維持色相、降低彩度', corrections.C2],
        ['C3', '最小色差（建議）', corrections.C3],
    ];
    return (
        <table className="w-full text-[11px]">
            <thead>
                <tr className="border-b border-base text-left text-[10px] uppercase text-faint">
                    <th className="py-1">修正</th><th>L*</th><th>a*</th><th>b*</th><th className="text-right">ΔE</th>
                </tr>
            </thead>
            <tbody>
                {rows.map(([key, desc, c]) => (
                    <tr key={key} className="border-b border-slate-100 last:border-0">
                        <td className="py-1.5">
                            <div className="font-semibold text-sub">{key}</div>
                            <div className="text-[10px] text-faint">{desc}</div>
                        </td>
                        {c ? (
                            <>
                                <td className="font-mono text-sub">{c.l.toFixed(1)}</td>
                                <td className="font-mono text-sub">{c.a.toFixed(1)}</td>
                                <td className="font-mono text-sub">{c.b.toFixed(1)}</td>
                                <td className="text-right font-mono text-sub">{c.dE.toFixed(2)}</td>
                            </>
                        ) : (
                            <td colSpan={4} className="text-center text-ghost">無解</td>
                        )}
                    </tr>
                ))}
            </tbody>
        </table>
    );
}

function SubstitutionPanel({ solverCols, current, compiled, usable, target }) {
    const [from, setFrom] = React.useState(0);
    const [to, setTo] = React.useState('');

    const result = React.useMemo(() => {
        if (!to || !compiled.models[to] || !current) return null;
        const items = solverCols.map((col, i) => ({ model: col.model, c: current[i], strength: col.strength }));
        const r = substitute({ items, substrate: compiled.substrate, index: from, newModel: compiled.models[to] });
        return { ...r, toTarget: colorDifference(r.after, target) };
    }, [from, to, current, solverCols, compiled, target]);

    if (!solverCols.length) return null;

    return (
        <Card title="置換模擬">
            <div className="flex items-end gap-2">
                <Field label="把這支" className="flex-1">
                    <Select value={from} onChange={(e) => setFrom(Number(e.target.value))}>
                        {solverCols.map((c, i) => <option key={c.id} value={i}>{c.name}</option>)}
                    </Select>
                </Field>
                <span className="pb-2 text-xs text-faint">換成</span>
                <Field label="這支（維持相同有效濃度）" className="flex-1">
                    <Select value={to} onChange={(e) => setTo(e.target.value)}>
                        <option value="">選擇色料…</option>
                        {usable.filter((c) => c.id !== solverCols[from]?.id)
                            .map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </Select>
                </Field>
            </div>

            {result && (
                <div className="mt-3 flex items-center gap-3">
                    <Swatch lab={result.before} size={36} />
                    <span className="text-faint">→</span>
                    <Swatch lab={result.after} size={36} />
                    <div className="flex-1 text-[11px]">
                        <div className="text-sub">
                            位移 ΔE₀₀ <span className="font-mono font-semibold">{result.dE00.toFixed(2)}</span>
                            （ΔL {result.diff.dL.toFixed(1)} · Δa {result.diff.da.toFixed(1)} · Δb {result.diff.db.toFixed(1)}）
                        </div>
                        <div className="text-faint">
                            換完後對目標色的 ΔE₀₀ = <span className="font-mono">{result.toTarget.dE00.toFixed(2)}</span>
                        </div>
                    </div>
                </div>
            )}
        </Card>
    );
}
