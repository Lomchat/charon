'use client';
import type { InstallNotification } from './useInstallNotifications';

type Props = {
  notifications: InstallNotification[];
  onOpen: (installId: string) => void;
  onDismiss: (installId: string) => void;
};

/**
 * Top-right popup that announces an install has finished (or failed).
 * Pattern copied from `<PermissionPopup>` — top-1 displayed large, the rest
 * in a sub-list (rare: we should almost never have +1 in parallel).
 *
 * Conditional render: `if (queue.length === 0) return null`.
 */
export default function InstallNotificationPopup({
  notifications, onOpen, onDismiss,
}: Props) {
  if (notifications.length === 0) return null;
  // Pop the latest (the freshest); the rest stay invisible as long as the
  // first one is not dismissed. Simpler than managing a complicated visual
  // stack for such a rare event.
  const top = notifications[notifications.length - 1];
  const cssClass = top.status === 'success' ? 'success' : 'error';

  return (
    <div className={`install-notif-popup ${cssClass}`} role="alert">
      <div className="install-notif-head">
        <span className="glyph">{top.status === 'success' ? '✓' : '✗'}</span>
        <span className="install-notif-title">
          {top.status === 'success' ? 'installation completed' : 'installation failed'}
        </span>
        <button
          type="button"
          className="install-notif-dismiss"
          onClick={() => onDismiss(top.installId)}
          title="hide this notification"
          aria-label="dismiss"
        >✕</button>
      </div>
      <div className="install-notif-body">
        VPS <strong>{top.vpsName}</strong>{' — '}
        {top.status === 'success'
          ? 'the agent is installed and operational.'
          : 'bootstrap failed. Check the log to understand.'}
        {notifications.length > 1 && (
          <span className="install-notif-more">{' '}(+{notifications.length - 1} others)</span>
        )}
      </div>
      <div className="install-notif-actions">
        <button
          type="button"
          className="primary"
          onClick={() => { onOpen(top.installId); onDismiss(top.installId); }}
        >
          view log
        </button>
      </div>
    </div>
  );
}
