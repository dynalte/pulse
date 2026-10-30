import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useHistory } from 'react-router-dom';
import { closeOutline, peopleOutline } from 'ionicons/icons';
import { IonIcon } from '@ionic/react';
import { useApp } from '../context/AppContext';
import { useMediaUrl } from '../services/media';
import { avatarColors, initials } from '../services/utils';

/* ------------------------------------------------------------------ logo */

export function Logo({ size = 40, withText = false }: { size?: number; withText?: boolean }) {
  return (
    <span className="logo" style={{ gap: withText ? 10 : 0 }}>
      <img src={`${import.meta.env.BASE_URL}logo.svg`} width={size} height={size} alt="Pulse" className="logo-img" />
      {withText && <span className="logo-text">Pulse</span>}
    </span>
  );
}

/* ---------------------------------------------------------------- avatar */

export interface AvatarProps {
  id?: number;
  name: string;
  avatarId?: number | null;
  size?: number;
  online?: boolean;
  group?: boolean;
  className?: string;
  ring?: boolean;
}

export function Avatar({ id = 0, name, avatarId, size = 44, online, group, className = '', ring }: AvatarProps) {
  const url = useMediaUrl(avatarId);
  const [c1, c2] = avatarColors(group ? id + 3 : id || name.length);
  const fontSize = Math.max(11, Math.round(size * (initials(name).length > 1 ? 0.36 : 0.42)));
  const badgeSize = Math.max(14, Math.round(size * 0.34));
  return (
    <span
      className={`avatar ${className} ${ring ? 'ring' : ''}`}
      style={{ width: size, height: size, fontSize, background: url ? '#243049' : `linear-gradient(135deg, ${c1}, ${c2})` }}
      aria-hidden="true"
    >
      {url ? <img src={url} alt="" /> : <span>{initials(name)}</span>}
      {online !== undefined && <i className={`presence ${online ? 'on' : ''}`} />}
      {group && (
        <i className="avatar-group-badge" style={{ width: badgeSize, height: badgeSize, fontSize: Math.max(8, Math.round(badgeSize * 0.6)) }}>
          <IonIcon icon={peopleOutline} />
        </i>
      )}
    </span>
  );
}

/* ------------------------------------------------------------- primitives */

export function IconButton({
  icon, label, onClick, active, variant = 'ghost', className = '', disabled, children,
}: {
  icon?: string;
  label: string;
  onClick?: (e: React.MouseEvent) => void;
  active?: boolean;
  variant?: 'ghost' | 'soft' | 'solid' | 'danger';
  className?: string;
  disabled?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className={`icon-btn ${variant} ${active ? 'active' : ''} ${className}`}
      onClick={onClick}
      aria-label={label}
      title={label}
      disabled={disabled}
    >
      {icon ? <IonIcon icon={icon} /> : children}
    </button>
  );
}

export function Spinner({ size = 22, label = 'Chargement' }: { size?: number; label?: string }) {
  return <span className="spinner" style={{ width: size, height: size }} role="status" aria-label={label} />;
}

export function LoadingScreen({ text = 'Chargement de Pulse…' }: { text?: string }) {
  return (
    <div className="loading-screen">
      <Logo size={64} />
      <Spinner size={26} />
      <p>{text}</p>
    </div>
  );
}

export function EmptyState({
  icon, title, text, action,
}: {
  icon: React.ReactNode;
  title: string;
  text?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="empty-state">
      <div className="empty-icon">{icon}</div>
      <h3>{title}</h3>
      {text && <p>{text}</p>}
      {action}
    </div>
  );
}

export function Badge({ count, muted }: { count: number; muted?: boolean }) {
  if (count <= 0) return null;
  return <span className={`unread-badge ${muted ? 'muted' : ''}`}>{count > 99 ? '99+' : count}</span>;
}

export function Tag({ children, tone = 'default' }: { children: React.ReactNode; tone?: 'default' | 'accent' | 'danger' | 'muted' }) {
  return <span className={`tag ${tone}`}>{children}</span>;
}

/* ------------------------------------------------------------------ modal */

export function Modal({
  open, title, onClose, children, footer, wide, sheet = true, className = '',
}: {
  open: boolean;
  title?: string;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  wide?: boolean;
  sheet?: boolean;
  className?: string;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previous;
    };
  }, [open, onClose]);

  if (!open) return null;
  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`modal ${sheet ? 'sheet' : ''} ${wide ? 'wide' : ''} ${className}`} role="dialog" aria-modal="true" aria-label={title}>
        {title !== undefined && (
          <header className="modal-head">
            <h2>{title}</h2>
            <IconButton icon={closeOutline} label="Fermer" onClick={onClose} />
          </header>
        )}
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-foot">{footer}</footer>}
      </div>
    </div>,
    document.body,
  );
}

export interface SheetAction {
  label: string;
  icon?: string;
  danger?: boolean;
  onClick: () => void;
  hidden?: boolean;
}

export function ActionSheet({
  open, title, subtitle, actions, onClose,
}: {
  open: boolean;
  title?: string;
  subtitle?: string;
  actions: SheetAction[];
  onClose: () => void;
}) {
  return (
    <Modal open={open} onClose={onClose} className="action-sheet">
      <div className="sheet-grabber" />
      {(title || subtitle) && (
        <div className="sheet-heading">
          {title && <strong>{title}</strong>}
          {subtitle && <span>{subtitle}</span>}
        </div>
      )}
      <div className="sheet-actions">
        {actions.filter((a) => !a.hidden).map((a) => (
          <button
            key={a.label}
            type="button"
            className={`sheet-action ${a.danger ? 'danger' : ''}`}
            onClick={() => { onClose(); a.onClick(); }}
          >
            {a.icon && <IonIcon icon={a.icon} />}
            <span>{a.label}</span>
          </button>
        ))}
      </div>
      <button type="button" className="sheet-cancel" onClick={onClose}>Annuler</button>
    </Modal>
  );
}

export function ConfirmDialog({
  open, title, message, confirmLabel = 'Confirmer', danger = false, onConfirm, onClose,
}: {
  open: boolean;
  title: string;
  message: React.ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Modal
      open={open}
      title={title}
      onClose={onClose}
      footer={(
        <>
          <button type="button" className="btn ghost" onClick={onClose}>Annuler</button>
          <button type="button" className={`btn ${danger ? 'danger' : 'primary'}`} onClick={() => { onClose(); onConfirm(); }}>
            {confirmLabel}
          </button>
        </>
      )}
    >
      <div className="confirm-text">{message}</div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ forms */

export function Field({
  label, hint, error, children, htmlFor,
}: {
  label?: string;
  hint?: string;
  error?: string;
  children: React.ReactNode;
  htmlFor?: string;
}) {
  return (
    <label className={`field ${error ? 'has-error' : ''}`} htmlFor={htmlFor}>
      {label && <span className="field-label">{label}</span>}
      {children}
      {hint && !error && <span className="field-hint">{hint}</span>}
      {error && <span className="field-error">{error}</span>}
    </label>
  );
}

export function Toggle({
  checked, onChange, label, description,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  description?: string;
}) {
  return (
    <div className="toggle-row">
      <div className="toggle-text">
        <strong>{label}</strong>
        {description && <span>{description}</span>}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        className={`switch ${checked ? 'on' : ''}`}
        onClick={() => onChange(!checked)}
      >
        <span />
      </button>
    </div>
  );
}

export function Segmented<T extends string>({
  value, options, onChange, label,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  label?: string;
}) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          className={value === o.value ? 'active' : ''}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/* ----------------------------------------------------------------- toasts */
export function Toasts() {
  const { toasts, dismissToast } = useApp();
  const history = useHistory();
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`toast ${t.tone || 'info'}`}
          onClick={() => {
            if (t.conversationId) history.push(`/chat/${t.conversationId}`);
            dismissToast(t.id);
          }}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => { if (e.key === 'Enter') { if (t.conversationId) history.push(`/chat/${t.conversationId}`); dismissToast(t.id); } }}
        >
          <Avatar id={t.conversationId || 0} name={t.title} avatarId={t.avatarId} size={38} />
          <div className="toast-text">
            <strong>{t.title}</strong>
            {t.body && <span>{t.body}</span>}
          </div>
          <button type="button" className="toast-close" aria-label="Fermer" onClick={(e) => { e.stopPropagation(); dismissToast(t.id); }}>
            <IonIcon icon={closeOutline} />
          </button>
        </div>
      ))}
    </div>
  );
}
