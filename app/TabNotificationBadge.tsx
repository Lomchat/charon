'use client';

import { useEffect } from 'react';

const ICON_SIZE = 64;
const BADGE_SELECTOR = 'link[data-charon-notification-badge]';

export default function TabNotificationBadge({ count }: { count: number }) {
  useEffect(() => {
    const title = document.title;
    return () => {
      document.title = title;
      document.querySelector(BADGE_SELECTOR)?.remove();
    };
  }, []);

  useEffect(() => {
    const title = count > 0 ? `(${count}) Charon` : 'Charon';
    const badge = document.querySelector<HTMLLinkElement>(BADGE_SELECTOR)
      ?? document.createElement('link');
    const originalRels = new Map<HTMLLinkElement, string>();
    const updateHead = () => {
      if (document.title !== title) document.title = title;
      if (count === 0 || !badge.href) return;
      for (const icon of document.querySelectorAll<HTMLLinkElement>('link[rel~="icon"]')) {
        if (icon === badge) continue;
        if (!originalRels.has(icon)) originalRels.set(icon, icon.rel);
        icon.rel = 'alternate';
      }
      if (!badge.isConnected) document.head.appendChild(badge);
    };
    const observer = new MutationObserver(updateHead);
    observer.observe(document.head, { childList: true, subtree: true, attributes: true, attributeFilter: ['rel'] });
    const cleanup = () => {
      observer.disconnect();
      for (const [icon, rel] of originalRels) icon.rel = rel;
    };
    updateHead();
    if (count === 0) {
      badge.remove();
      return cleanup;
    }

    let active = true;
    const image = new Image();
    image.onload = () => {
      if (!active) return;
      const canvas = document.createElement('canvas');
      canvas.width = ICON_SIZE;
      canvas.height = ICON_SIZE;
      const context = canvas.getContext('2d');
      if (!context) return;
      context.drawImage(image, 0, 0, ICON_SIZE, ICON_SIZE);
      context.beginPath();
      context.arc(47, 47, 17, 0, Math.PI * 2);
      context.fillStyle = '#ed4245';
      context.fill();
      context.lineWidth = 3;
      context.strokeStyle = '#fff';
      context.stroke();
      const label = count > 99 ? '99+' : String(count);
      context.fillStyle = '#fff';
      context.font = `bold ${label.length === 1 ? 27 : label.length === 2 ? 22 : 16}px Arial, sans-serif`;
      context.textAlign = 'center';
      context.textBaseline = 'middle';
      context.fillText(label, 47, 48);
      badge.rel = 'icon';
      badge.type = 'image/png';
      badge.sizes = `${ICON_SIZE}x${ICON_SIZE}`;
      badge.dataset.charonNotificationBadge = '';
      badge.href = canvas.toDataURL('image/png');
      updateHead();
    };
    image.src = '/icon.svg';
    return () => { active = false; cleanup(); };
  }, [count]);

  return null;
}
