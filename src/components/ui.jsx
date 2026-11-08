import React from 'react';
import { labToHex } from '../color/colorUtils.js';

export const Card = ({ title, right, children, className = '' }) => (
    <div className={`rounded-lg border border-base surface shadow-sm ${className}`}>
        {(title || right) && (
            <div className="flex items-center justify-between gap-2 border-b border-base px-3 py-2">
                <h3 className="text-sm font-semibold text-sub">{title}</h3>
                {right}
            </div>
        )}
        <div className="p-3">{children}</div>
    </div>
);

export const Button = ({ variant = 'default', className = '', ...props }) => {
    const styles = {
        default: 'surface border-strong text-sub hover-row',
        primary: 'bg-blue-600 border-blue-600 text-white hover:bg-blue-700',
        danger: 'surface border-red-300 text-bad hover:bg-red-50 dark:border-red-900 dark:hover:bg-red-950/40',
        ghost: 'bg-transparent border-transparent text-muted hover-row',
    }[variant];
    return (
        <button
            {...props}
            className={`rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${styles} ${className}`}
        />
    );
};

export const Field = ({ label, hint, children, className = '' }) => (
    <label className={`block ${className}`}>
        <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-muted">{label}</span>
        {children}
        {hint && <span className="mt-1 block text-[11px] text-faint">{hint}</span>}
    </label>
);

const inputCls =
    'w-full rounded-md border border-strong bg-white px-2 py-1.5 text-sm text-main outline-none '
    + 'focus:border-blue-500 focus:ring-1 focus:ring-blue-500 '
    + 'dark:bg-slate-950 dark:[color-scheme:dark] disabled:opacity-50';

export const TextInput = ({ className = '', ...props }) => (
    <input type="text" {...props} className={`${inputCls} ${className}`} />
);

/**
 * 數值輸入。保留使用者正在輸入的中間狀態（例如 "0." 或 "-"），
 * 否則每打一個字就被 parseFloat 吃掉，無法輸入小數。
 */
export const NumberInput = ({ value, onChange, step = 'any', className = '', ...props }) => {
    const [draft, setDraft] = React.useState(null);
    const shown = draft ?? (value == null || Number.isNaN(value) ? '' : String(value));
    return (
        <input
            {...props}
            type="number"
            step={step}
            inputMode="decimal"
            value={shown}
            onChange={(e) => {
                const t = e.target.value;
                setDraft(t);
                if (t === '' || t === '-' || t.endsWith('.')) return;
                const n = parseFloat(t);
                if (!Number.isNaN(n)) onChange(n);
            }}
            onBlur={() => setDraft(null)}
            className={`${inputCls} ${className}`}
        />
    );
};

export const Select = ({ className = '', children, ...props }) => (
    <select {...props} className={`${inputCls} ${className}`}>{children}</select>
);

export const Swatch = ({ lab, size = 28, className = '' }) => (
    <span
        className={`inline-block shrink-0 rounded border border-strong ${className}`}
        style={{
            width: size, height: size,
            background: lab ? labToHex(lab.l, lab.a, lab.b) : 'repeating-linear-gradient(45deg,var(--plot-grid),var(--plot-grid) 4px,var(--plot-face) 4px,var(--plot-face) 8px)',
        }}
        title={lab ? `L ${lab.l.toFixed(1)}  a ${lab.a.toFixed(1)}  b ${lab.b.toFixed(1)}` : '無資料'}
    />
);

/** Lab 三欄輸入 */
export const LabInput = ({ lab, onChange, disabled }) => {
    const set = (k) => (v) => onChange({ ...lab, [k]: v });
    return (
        <div className="flex items-center gap-1.5">
            <Swatch lab={lab} />
            {['l', 'a', 'b'].map((k) => (
                <div key={k} className="flex-1">
                    <div className="mb-0.5 text-center text-[10px] font-semibold uppercase text-faint">{k === 'l' ? 'L*' : `${k}*`}</div>
                    <NumberInput value={lab?.[k] ?? ''} onChange={set(k)} disabled={disabled} className="text-center" />
                </div>
            ))}
        </div>
    );
};

/** 信心分數徽章 */
export const ConfidenceBadge = ({ confidence }) => {
    if (!confidence) return null;
    const { score, level } = confidence;
    const style = {
        high: 'tone-good',
        medium: 'tone-warn',
        low: 'tone-bad',
    }[level];
    const label = { high: '可直接打樣', medium: '建議先試片', low: '僅供參考' }[level];
    return (
        <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium ${style}`}>
            信心 {score} · {label}
        </span>
    );
};

/** ΔE 顯示，依門檻上色 */
export const DeltaEBadge = ({ value, threshold = 1.0 }) => {
    const tone = value <= threshold ? 'tone-good'
        : value <= threshold * 2 ? 'tone-warn'
            : 'tone-bad';
    return (
        <span className={`inline-block rounded border px-1.5 py-0.5 font-mono text-[11px] font-semibold ${tone}`}>
            ΔE₀₀ {value.toFixed(2)}
        </span>
    );
};

export const Empty = ({ children }) => (
    <div className="px-3 py-8 text-center text-xs text-faint">{children}</div>
);

export const Warnings = ({ items }) => {
    if (!items || !items.length) return null;
    return (
        <ul className="space-y-1 rounded-md border tone-warn p-2 text-[11px]">
            {items.map((w, i) => <li key={i}>· {w}</li>)}
        </ul>
    );
};

export const Tabs = ({ tabs, value, onChange }) => (
    <div className="flex gap-1 rounded-lg surface-3 p-1">
        {tabs.map((t) => (
            <button
                key={t.id}
                onClick={() => onChange(t.id)}
                className={`flex-1 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                    value === t.id ? 'surface text-main shadow-sm' : 'text-muted hover:text-main'}`}
            >
                {t.label}
            </button>
        ))}
    </div>
);

export const fmt = (v, d = 3) =>
    v == null || Number.isNaN(v) ? '—' : (Math.round(v * 10 ** d) / 10 ** d).toString();
