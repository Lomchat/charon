'use client';
import type { ReactNode } from 'react';
import { NOTIFICATION_EVENTS, SESSION_NOTIFICATION_EVENTS, type ChannelNotificationPreferences, type NotificationEvent } from '@/lib/notificationPreferences';
import { IconBellFill, IconTelegram } from './icons';

const COPY: Record<NotificationEvent, [string, string]> = {
  updates: ['Updates', 'Available agent, SDK and CLI versions and update results.'],
  session_finished: ['Session finished', 'The response and all background tasks have finished.'],
  session_error: ['Session error', 'A blocking error interrupted the session.'],
  session_background: ['Background tasks running', 'The response finished, but background tasks are still running.'],
  permission: ['Permission requests', 'An action needs your approval.'],
  question: ['Questions', 'The agent is waiting for your reply.'],
  plan: ['Plan approvals', 'A plan is ready for your approval.'],
  installation: ['Agent installation', 'An agent installation succeeded or failed.'],
  shell_idle: ['Terminal activity finished', 'A terminal becomes idle after completing work.'],
};
type ChannelControls = {
  value: ChannelNotificationPreferences;
  onChange: (value: ChannelNotificationPreferences) => void;
  busy?: boolean;
  inherit?: boolean;
  onInherit?: (value: boolean) => void;
};

function NotificationSwitch({ checked, onChange, label, disabled }: {
  checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean;
}) {
  return <label className="notification-toggle" title={label}>
    <input className="notification-switch-input" type="checkbox" role="switch" aria-label={label} checked={checked}
      disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
    <span className="notification-switch" aria-hidden="true" />
  </label>;
}

/** One row per event; each delivery channel retains its own persistence/inheritance. */
export function NotificationTable({ browser, telegram, session = false }: {
  browser: ChannelControls; telegram: ChannelControls | null; session?: boolean;
}) {
  const channels = [{ name: 'Browser', controls: browser }, { name: 'Telegram', controls: telegram }];
  const custom = !session || !browser.inherit || (telegram !== null && !telegram.inherit);
  const unavailable = (reason: string) => <span className="notification-unavailable" title={reason} aria-label={reason}>—</span>;
  function cells(label: string, read: (value: ChannelNotificationPreferences) => boolean,
    write: (value: ChannelNotificationPreferences, enabled: boolean) => ChannelNotificationPreferences,
    browserOnly = false) {
    return channels.map(({ name, controls }) => <td key={name}>
      {!controls ? unavailable('Loading Telegram settings')
        : browserOnly && name === 'Telegram' ? unavailable('Sound is managed in the Telegram app')
        : controls.inherit ? unavailable('Using global settings')
        : <NotificationSwitch label={`${name}: ${label}`} checked={read(controls.value)} disabled={controls.busy}
          onChange={(enabled) => controls.onChange(write(controls.value, enabled))} />}
    </td>);
  }
  function row(title: string, description: string | undefined, content: ReactNode) {
    return <tr key={title}><th scope="row"><span>{title}</span>{description && <small>{description}</small>}</th>{content}</tr>;
  }
  function events(sessionEvents: boolean) {
    return NOTIFICATION_EVENTS.filter(({ id }) => SESSION_NOTIFICATION_EVENTS.some((event) => event.id === id) === sessionEvents)
      .map(({ id }) => row(COPY[id][0], COPY[id][1], cells(COPY[id][0], (v) => v.events[id],
        (v, enabled) => ({ ...v, events: { ...v.events, [id]: enabled } }))));
  }
  return <table className="notification-table" aria-label="Notification preferences">
    <colgroup><col /><col className="notification-channel-column" /><col className="notification-channel-column" /></colgroup>
    <thead><tr>
      <th scope="col">Event</th>
      <th scope="col"><span className="notification-column-title"><IconBellFill />Browser</span><small>This browser</small></th>
      <th scope="col"><span className="notification-column-title"><IconTelegram />Telegram</span><small>All devices</small></th>
    </tr></thead>
    {session && <tbody>{row('Use defaults', 'Inherit global settings for each channel.', channels.map(({ name, controls }) => <td key={name}>
      {controls?.onInherit ? <NotificationSwitch label={`${name}: Use defaults`} checked={!!controls.inherit}
        onChange={controls.onInherit} disabled={controls.busy} /> : unavailable('Loading Telegram settings')}
    </td>))}</tbody>}
    {custom && <>
      <tbody>
        {row('Enable notifications', undefined, cells('enable notifications', (v) => v.enabled, (v, enabled) => ({ ...v, enabled })))}
        {!browser.inherit && row('Sound', 'Play a sound when a browser notification arrives.', cells('sound', (v) => v.sound, (v, sound) => ({ ...v, sound }), true))}
      </tbody>
      <tbody><tr className="notification-section-row"><th colSpan={3}>Session events</th></tr>{events(true)}</tbody>
      {!session && <tbody><tr className="notification-section-row"><th colSpan={3}>Agents and terminals</th></tr>{events(false)}</tbody>}
    </>}
  </table>;
}
