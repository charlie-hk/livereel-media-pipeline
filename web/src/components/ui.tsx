import type { ButtonHTMLAttributes, ReactNode } from 'react';

export function Card({
  title,
  subtitle,
  action,
  children,
  className = '',
}: {
  title: string;
  subtitle?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`card ${className}`}>
      <header className="flex items-start justify-between gap-3 px-4 py-3 border-b border-edge/60">
        <div>
          <h2 className="text-sm font-semibold text-slate-100">{title}</h2>
          {subtitle ? <p className="text-xs text-muted mt-0.5">{subtitle}</p> : null}
        </div>
        {action}
      </header>
      <div className="p-4">{children}</div>
    </section>
  );
}

const TONES = {
  good: 'bg-good/15 text-good border-good/30',
  warn: 'bg-warn/15 text-warn border-warn/30',
  bad: 'bg-bad/15 text-bad border-bad/30',
  info: 'bg-accent/15 text-sky-300 border-accent/30',
  mute: 'bg-ink-600 text-muted border-edge',
} as const;

export type Tone = keyof typeof TONES;

export function Badge({ tone = 'mute', children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md border text-[11px] font-medium font-mono ${TONES[tone]}`}
    >
      {children}
    </span>
  );
}

export function Dot({ tone }: { tone: Tone }) {
  const colour =
    tone === 'good' ? 'bg-good' : tone === 'bad' ? 'bg-bad' : tone === 'warn' ? 'bg-warn' : 'bg-muted';
  return <span className={`inline-block w-1.5 h-1.5 rounded-full ${colour}`} />;
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'ghost' | 'danger';
};

export function Button({ variant = 'ghost', className = '', ...props }: ButtonProps) {
  const styles =
    variant === 'primary'
      ? 'bg-accent hover:bg-accent/85 text-white border-transparent'
      : variant === 'danger'
        ? 'bg-bad/15 hover:bg-bad/25 text-bad border-bad/30'
        : 'bg-ink-600 hover:bg-ink-500 text-slate-200 border-edge';

  return (
    <button
      {...props}
      className={`px-3 py-1.5 rounded-lg border text-xs font-semibold transition-colors
                  disabled:opacity-45 disabled:cursor-not-allowed ${styles} ${className}`}
    />
  );
}

export function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="label">{label}</div>
      <div className="mt-1 font-mono text-sm text-slate-100 truncate">{value}</div>
      {hint ? <div className="text-[11px] text-muted mt-0.5 truncate">{hint}</div> : null}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="text-sm text-muted py-6 text-center">{children}</p>;
}
