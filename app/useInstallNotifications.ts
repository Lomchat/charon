'use client';
import { useEffect, useState } from 'react';
import { subscribeAll } from './globalEventStream';
import type { InstallStatus } from '@/lib/types/api';

// useInstallNotifications
// ─────────────────────────────────────────────────────────────────────────────
// Maintains a queue of finished installs that have not yet been acknowledged,
// fed by the `install_finished` events from the global bus.
//
// Why: when an install finishes (success or error), the user is maybe not
// in front of the install session — they may be on another Claude session,
// or have the tab in the background. So we store the notification in a
// tab-local queue and display it top-right via
// `<InstallNotificationPopup>` (PermissionPopup pattern).
//
// The user explicitly dismisses the notification (click ✕) or clicks "see
// the log" which focuses the install session and dismisses it at the
// same time.

export type InstallNotification = {
  installId: string;
  vpsId: string;
  vpsName: string;
  status: InstallStatus;          // 'success' | 'error' (never 'running' here)
  finishedAt: number;
};

export function useInstallNotifications(): {
  notifications: InstallNotification[];
  dismiss: (installId: string) => void;
  clear: () => void;
} {
  const [notifications, setNotifications] = useState<InstallNotification[]>([]);

  useEffect(() => {
    const unsubscribe = subscribeAll((ev) => {
      // Only handle install events; session events are filtered
      // by hasSessionId on the globalEventStream side but we keep a safety net here.
      if (!('installId' in ev)) return;
      if (ev.type === 'install_finished' && (ev.status === 'success' || ev.status === 'error')) {
        setNotifications((prev) => {
          // Dedup by installId — if we receive multiple install_finished
          // for the same id (rare, but possible if the user retries), we keep
          // only the last one.
          const filtered = prev.filter((n) => n.installId !== ev.installId);
          return [...filtered, {
            installId: ev.installId,
            vpsId: ev.vpsId,
            vpsName: ev.vpsName,
            status: ev.status,
            finishedAt: Math.floor(Date.now() / 1000),
          }];
        });
      }
    });
    return () => { unsubscribe(); };
  }, []);

  return {
    notifications,
    dismiss: (installId) =>
      setNotifications((prev) => prev.filter((n) => n.installId !== installId)),
    clear: () => setNotifications([]),
  };
}
