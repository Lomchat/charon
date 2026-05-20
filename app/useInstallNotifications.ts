'use client';
import { useEffect, useState } from 'react';
import { subscribeAll } from './globalEventStream';
import type { InstallStatus } from '@/lib/types/api';

// useInstallNotifications
// ─────────────────────────────────────────────────────────────────────────────
// Maintient une queue d'installs terminées qu'on n'a pas encore acquittées,
// alimentée par les events `install_finished` du bus global.
//
// Pourquoi : quand une install se termine (success ou error), l'user n'est
// peut-être pas devant la session install — il peut être sur une autre
// session Claude, ou avoir l'onglet en background. On stocke donc la notif
// dans une queue locale au tab et on l'affiche en top-right via
// `<InstallNotificationPopup>` (pattern PermissionPopup).
//
// L'utilisateur dismiss explicitement la notif (clic ✕) ou clique "voir le
// log" qui focus la session install et la dismiss en même temps.

export type InstallNotification = {
  installId: string;
  vpsId: string;
  vpsName: string;
  status: InstallStatus;          // 'success' | 'error' (jamais 'running' ici)
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
      // On ne traite que les install events ; les events session sont filtrés
      // par hasSessionId côté globalEventStream mais on garde une safety net ici.
      if (!('installId' in ev)) return;
      if (ev.type === 'install_finished' && (ev.status === 'success' || ev.status === 'error')) {
        setNotifications((prev) => {
          // Dédup par installId — si on reçoit plusieurs install_finished
          // pour le même id (rare, mais possible si le user retry), on garde
          // uniquement le dernier.
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
