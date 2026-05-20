'use client';
import type { InstallNotification } from './useInstallNotifications';

type Props = {
  notifications: InstallNotification[];
  onOpen: (installId: string) => void;
  onDismiss: (installId: string) => void;
};

/**
 * Popup top-right qui annonce qu'une install s'est terminée (ou a échoué).
 * Pattern copié sur `<PermissionPopup>` — top-1 affiché en gros, les autres
 * en sous-liste (rare : on ne devrait quasi-jamais en avoir +1 en parallèle).
 *
 * Render conditionnel : `if (queue.length === 0) return null`.
 */
export default function InstallNotificationPopup({
  notifications, onOpen, onDismiss,
}: Props) {
  if (notifications.length === 0) return null;
  // Pop la dernière (la plus fraîche) ; les autres restent invisibles tant
  // qu'on n'a pas dismiss la première. Plus simple que de gérer une stack
  // visuelle compliquée pour un event aussi rare.
  const top = notifications[notifications.length - 1];
  const cssClass = top.status === 'success' ? 'success' : 'error';

  return (
    <div className={`install-notif-popup ${cssClass}`} role="alert">
      <div className="install-notif-head">
        <span className="glyph">{top.status === 'success' ? '✓' : '✗'}</span>
        <span className="install-notif-title">
          {top.status === 'success' ? 'installation terminée' : 'installation échouée'}
        </span>
        <button
          type="button"
          className="install-notif-dismiss"
          onClick={() => onDismiss(top.installId)}
          title="masquer cette notification"
          aria-label="dismiss"
        >✕</button>
      </div>
      <div className="install-notif-body">
        VPS <strong>{top.vpsName}</strong>{' — '}
        {top.status === 'success'
          ? 'l\'agent est installé et opérationnel.'
          : 'le bootstrap a échoué. Consulte le log pour comprendre.'}
        {notifications.length > 1 && (
          <span className="install-notif-more">{' '}(+{notifications.length - 1} autres)</span>
        )}
      </div>
      <div className="install-notif-actions">
        <button
          type="button"
          className="primary"
          onClick={() => { onOpen(top.installId); onDismiss(top.installId); }}
        >
          voir le log
        </button>
      </div>
    </div>
  );
}
