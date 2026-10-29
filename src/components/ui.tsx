import type { ReactNode } from 'react';
import type { IconName } from '../../shared/types';
import { Icon } from './Icon';

/** The signature glass capsule button (the "Clean" button). */
export function CleanButton({
  label,
  sub,
  icon = 'broom',
  done = false,
  busy = false,
  onClick,
  disabled,
}: {
  label: string;
  sub?: string;
  icon?: IconName;
  done?: boolean;
  busy?: boolean;
  onClick?: () => void;
  disabled?: boolean;
}) {
  return (
    <button type="button" className={`cta${done ? ' done' : ''}${busy ? ' busy' : ''}`} onClick={onClick} disabled={disabled || busy}>
      <span className="cta-ico">{busy ? <span className="spinner" style={{ borderColor: 'rgba(255,255,255,0.4)', borderTopColor: '#fff' }} /> : <Icon name={done ? 'check' : icon} />}</span>
      <span className="cta-t">
        <b>{label}</b>
        {sub && <small>{sub}</small>}
      </span>
    </button>
  );
}

export function ScreenHead({ title, sub, children }: { title: string; sub?: ReactNode; children?: ReactNode }) {
  return (
    <header className="screen-head rise">
      <div>
        <h1>{title}</h1>
        {sub && <p>{sub}</p>}
      </div>
      <div className="grow" />
      {children}
    </header>
  );
}

export function Empty({ icon, title, text, children }: { icon: IconName; title: string; text?: ReactNode; children?: ReactNode }) {
  return (
    <div className="empty">
      <span className="chip-ico" style={{ width: 52, height: 52, borderRadius: 18 }}>
        <Icon name={icon} size={26} />
      </span>
      <h3>{title}</h3>
      {text && <p>{text}</p>}
      {children}
    </div>
  );
}

export function Progress({ value }: { value?: number }) {
  if (value === undefined) {
    return (
      <div className="progress">
        <i />
      </div>
    );
  }
  return (
    <div className="progress" data-value={value}>
      <i style={{ width: `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%` }} />
    </div>
  );
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return <button type="button" role="switch" aria-checked={checked} aria-label={label} className="toggle" onClick={() => onChange(!checked)} />;
}

export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={o.value === value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}
