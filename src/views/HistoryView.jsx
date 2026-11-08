import React from 'react';
import {
    Card, Button, Field, NumberInput, TextInput, Select, LabInput, Swatch,
    DeltaEBadge, Empty, fmt,
} from '../components/ui.jsx';
import { predictFormulation } from '../color/engine.js';
import {
    makeFormulation, RECIPE_MODE, effectiveConcentrations, checkLimits,
} from '../data/schema.js';
import { deltaE00 } from '../color/colorUtils.js';

/**
 * 歷史配方：輸入已打樣過的配方與實測色。
 * 這些資料是校正層的訓練集，也是信心分數的依據。
 */
export default function HistoryView({ db, compiled, settings, onChange }) {
    const [editing, setEditing] = React.useState(null);
    const update = (patch) => onChange({ ...db, ...patch });
    const current = db.formulations.find((f) => f.id === editing);

    const add = () => {
        const f = makeFormulation({
            name: `配方 ${db.formulations.length + 1}`,
            baseResinId: settings.baseResinId,
            carrierId: settings.carrierId,
            condition: settings.condition,
        });
        update({ formulations: [...db.formulations, f] });
        setEditing(f.id);
    };

    return (
        <div className="grid h-full grid-cols-1 gap-3 overflow-auto p-3 lg:grid-cols-[360px_minmax(0,1fr)]">
            <div className="space-y-3">
                <Card title={`歷史配方 ${db.formulations.length}`}
                    right={<Button variant="primary" onClick={add}>新增</Button>}>
                    {db.formulations.length === 0 ? (
                        <Empty>
                            還沒有歷史配方。<br />
                            輸入打過樣的配方與實測色，程式就能校正色力並提高預測準度。
                        </Empty>
                    ) : (
                        <div className="space-y-1">
                            {db.formulations.map((f) => (
                                    <button key={f.id} onClick={() => setEditing(f.id)}
                                        className={`flex w-full items-center gap-2 rounded-md border px-2 py-1.5 text-left ${
                                            editing === f.id ? 'accent-edge accent-soft' : 'border-base hover-row'}`}>
                                        <Swatch lab={f.measuredLab} size={20} />
                                        <div className="min-w-0 flex-1">
                                            <div className="truncate text-xs font-medium text-sub">{f.name}</div>
                                            <div className="text-[10px] text-faint">
                                                {f.date} · {f.components.length} 成分 · {f.status}
                                                {!f.measuredLab && ' · 未填實測色'}
                                            </div>
                                        </div>
                                    </button>
                            ))}
                        </div>
                    )}
                </Card>

                <CalibrationReport compiled={compiled} db={db} />
            </div>

            <div>
                {current ? (
                    <FormulationEditor
                        formulation={current} db={db} compiled={compiled}
                        onSave={(next) => update({ formulations: db.formulations.map((f) => (f.id === next.id ? next : f)) })}
                        onDelete={(id) => { update({ formulations: db.formulations.filter((f) => f.id !== id) }); setEditing(null); }}
                    />
                ) : (
                    <Card title="配方內容"><Empty>選一張配方，或新增一張</Empty></Card>
                )}
            </div>
        </div>
    );
}

/* ------------------------------------------------------------------ */

function CalibrationReport({ compiled, db }) {
    const { calib, sampleCount } = compiled;
    const used = calib?.used || [];

    return (
        <Card title="校正狀態">
            {sampleCount === 0 ? (
                <p className="text-[11px] text-muted">
                    目前沒有符合條件的歷史配方。校正只會用「同基礎樹酯 + 同載體 + 同量測條件」的配方，
                    請確認上方設定與配方內容一致。
                </p>
            ) : (
                <>
                    <dl className="grid grid-cols-2 gap-y-1 text-[11px]">
                        <dt className="text-faint">訓練配方數</dt>
                        <dd className="text-right font-mono text-sub">{sampleCount}</dd>
                        <dt className="text-faint">校正前 RMS ΔE₀₀</dt>
                        <dd className="text-right font-mono text-sub">{calib.baseline?.rmsDE00?.toFixed(2) ?? '—'}</dd>
                        <dt className="text-faint">校正後 RMS ΔE₀₀</dt>
                        <dd className="text-right font-mono font-semibold text-main">{calib.evaluation.rmsDE00.toFixed(2)}</dd>
                        <dt className="text-faint">最大 ΔE₀₀</dt>
                        <dd className="text-right font-mono text-sub">{calib.evaluation.maxDE00.toFixed(2)}</dd>
                    </dl>

                    {calib.rejected && (
                        <p className="mt-2 rounded border tone-warn p-2 text-[11px]">
                            校正後誤差沒有改善，已自動略過色力校正。通常代表歷史配方的量測條件不一致。
                        </p>
                    )}

                    {used.length > 0 && (
                        <div className="mt-2">
                            <div className="mb-1 text-[11px] font-medium text-sub">色力係數</div>
                            <div className="space-y-0.5">
                                {used.map((id) => {
                                    const s = calib.strengths[id];
                                    const dev = (s - 1) * 100;
                                    return (
                                        <div key={id} className="flex items-center justify-between text-[11px]">
                                            <span className="truncate text-sub">{compiled.colorantsById[id]?.name || id}</span>
                                            <span className={`font-mono ${Math.abs(dev) > 10 ? 'text-warn' : 'text-muted'}`}>
                                                {s.toFixed(3)}（{dev >= 0 ? '+' : ''}{dev.toFixed(1)}%）
                                            </span>
                                        </div>
                                    );
                                })}
                            </div>
                            <p className="mt-1 text-[10px] text-faint">
                                偏離 1.0 代表實際色力與建檔曲線有差異，可能是批次差或分散不同。
                            </p>
                        </div>
                    )}
                </>
            )}
        </Card>
    );
}

/* ------------------------------------------------------------------ */

function FormulationEditor({ formulation, db, compiled, onSave, onDelete }) {
    const f = formulation;
    const set = (patch) => onSave({ ...f, ...patch });
    const prediction = React.useMemo(() => predictFormulation(f, compiled), [f, compiled]);
    const eff = effectiveConcentrations(f, compiled.colorantsById);
    const violations = checkLimits(eff);

    const dE = f.measuredLab ? deltaE00(prediction.lab, f.measuredLab) : null;

    return (
        <div className="space-y-3">
            <Card title="配方內容" right={<Button variant="danger" onClick={() => onDelete(f.id)}>刪除</Button>}>
                <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                    <Field label="名稱" className="col-span-2">
                        <TextInput value={f.name} onChange={(e) => set({ name: e.target.value })} />
                    </Field>
                    <Field label="日期">
                        <TextInput type="date" value={f.date} onChange={(e) => set({ date: e.target.value })} />
                    </Field>
                    <Field label="狀態">
                        <Select value={f.status} onChange={(e) => set({ status: e.target.value })}>
                            <option>試打</option><option>量產</option><option>棄用</option>
                        </Select>
                    </Field>

                    <Field label="基礎樹酯">
                        <Select value={f.baseResinId || ''} onChange={(e) => set({ baseResinId: e.target.value || null })}>
                            <option value="">未指定</option>
                            {db.resins.filter((r) => r.usage !== 'carrier').map((r) =>
                                <option key={r.id} value={r.id}>{r.name}</option>)}
                        </Select>
                    </Field>
                    <Field label="母粒載體">
                        <Select value={f.carrierId || ''} onChange={(e) => set({ carrierId: e.target.value || null })}>
                            <option value="">未指定</option>
                            {db.resins.filter((r) => r.usage !== 'base').map((r) =>
                                <option key={r.id} value={r.id}>{r.name}</option>)}
                        </Select>
                    </Field>
                    <Field label="配方形式">
                        <Select value={f.mode} onChange={(e) => set({ mode: e.target.value })}>
                            <option value={RECIPE_MODE.DIRECT}>直接添加</option>
                            <option value={RECIPE_MODE.MASTERBATCH}>母粒 letdown</option>
                        </Select>
                    </Field>
                    {f.mode === RECIPE_MODE.MASTERBATCH ? (
                        <Field label="letdown wt%">
                            <NumberInput value={f.letdown} onChange={(v) => set({ letdown: v })} />
                        </Field>
                    ) : <div />}

                    <Field label="量測條件" className="col-span-2 lg:col-span-4"
                        hint="板厚、SCI/SCE、射出條件等。條件不同的配方不會混在一起校正。">
                        <TextInput value={f.condition} onChange={(e) => set({ condition: e.target.value })}
                            placeholder="例如 2mm 射出板 / SCI / D65-10°" />
                    </Field>
                </div>
            </Card>

            <Card title="成分" right={
                <Select value="" className="w-48 py-1 text-[11px]"
                    onChange={(e) => {
                        if (!e.target.value) return;
                        set({ components: [...f.components, { colorantId: e.target.value, value: 1 }] });
                    }}>
                    <option value="">加入色料…</option>
                    {db.colorants.filter((c) => !f.components.some((x) => x.colorantId === c.id))
                        .map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </Select>
            }>
                {f.components.length === 0 ? <Empty>尚未加入成分</Empty> : (
                    <table className="w-full text-xs">
                        <thead>
                            <tr className="border-b border-base text-left text-[10px] uppercase text-faint">
                                <th className="py-1">色料</th>
                                <th className="py-1 text-right">
                                    {f.mode === RECIPE_MODE.MASTERBATCH ? '佔母粒 wt%' : '佔製品 wt%'}
                                </th>
                                <th className="py-1 text-right">顏料有效濃度</th>
                                <th />
                            </tr>
                        </thead>
                        <tbody>
                            {f.components.map((comp, i) => (
                                <tr key={comp.colorantId} className="border-b border-slate-100 last:border-0">
                                    <td className="py-1.5">
                                        <div className="flex items-center gap-1.5">
                                            <Swatch lab={compiled.colorantsById[comp.colorantId]?.curve?.[0]?.lab} size={16} />
                                            <span className="text-sub">
                                                {compiled.colorantsById[comp.colorantId]?.name || '(已刪除的色料)'}
                                            </span>
                                        </div>
                                    </td>
                                    <td className="py-1.5 text-right">
                                        <NumberInput value={comp.value}
                                            onChange={(v) => set({
                                                components: f.components.map((x, j) => (j === i ? { ...x, value: v } : x)),
                                            })}
                                            className="w-24 py-0.5 text-right font-mono text-[11px]" />
                                    </td>
                                    <td className="py-1.5 text-right font-mono text-muted">
                                        {fmt(eff[i]?.c)} %
                                    </td>
                                    <td className="py-1.5 text-right">
                                        <Button variant="ghost"
                                            onClick={() => set({ components: f.components.filter((_, j) => j !== i) })}>
                                            刪除
                                        </Button>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}

                {violations.length > 0 && (
                    <ul className="mt-2 space-y-1 rounded-md border tone-warn p-2 text-[11px]">
                        {violations.map((v, i) => (
                            <li key={i}>
                                · {v.name}：有效濃度 {fmt(v.value)}%
                                {v.kind === 'below_min' ? ` 低於最低含量 ${fmt(v.limit)}%` : ` 超過上限 ${fmt(v.limit)}%`}
                            </li>
                        ))}
                    </ul>
                )}
            </Card>

            <Card title="實測與預測比對" right={dE != null && <DeltaEBadge value={dE} />}>
                <div className="grid grid-cols-2 gap-4">
                    <div>
                        <div className="mb-1 text-[11px] font-medium text-sub">實測色</div>
                        {f.measuredLab
                            ? <LabInput lab={f.measuredLab} onChange={(v) => set({ measuredLab: v })} />
                            : <Button onClick={() => set({ measuredLab: { l: 50, a: 0, b: 0 } })}>填入實測色</Button>}
                    </div>
                    <div>
                        <div className="mb-1 text-[11px] font-medium text-sub">模型預測</div>
                        <div className="flex items-center gap-2">
                            <Swatch lab={prediction.lab} size={28} />
                            <span className="font-mono text-[11px] text-sub">
                                L {prediction.lab.l.toFixed(1)} · a {prediction.lab.a.toFixed(1)} · b {prediction.lab.b.toFixed(1)}
                            </span>
                        </div>
                        {prediction.residual?.weight > 0.01 && (
                            <div className="mt-1 text-[10px] text-faint">
                                已套用殘差修正（權重 {prediction.residual.weight.toFixed(2)}）
                            </div>
                        )}
                    </div>
                </div>

                {f.measuredLab && (
                    <p className="mt-3 text-[11px] text-muted">
                        這張配方本身也是校正訓練集的一員，所以這裡的誤差會偏樂觀。
                        要看真實準度，請參考左側「校正狀態」的整體 RMS。
                    </p>
                )}
            </Card>
        </div>
    );
}
