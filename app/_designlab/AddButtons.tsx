'use client';
import { IconRobot, IconTerminal } from '../icons';

// Shared "＋ Agent / ＋ Shell" control, styled like v3's segmented pill group.
// Reused by all three explorations so the button language is identical; only
// placement/size changes per version.
//   size: 'md' (top toolbar) | 'sm' (per-VPS header)
//   iconOnly: drop the text labels (tight per-VPS headers)
//   full: each button grows to fill the row (50/50)
export default function AddButtons({
  onAgent, onShell, size = 'md', iconOnly = false, full = false,
}: {
  onAgent: () => void;
  onShell: () => void;
  size?: 'md' | 'sm';
  iconOnly?: boolean;
  full?: boolean;
}) {
  return (
    <div className={`lab-add lab-add-${size}${full ? ' full' : ''}`}>
      <button className="lab-add-btn agent" onClick={onAgent} title="new Claude agent">
        <IconRobot />{!iconOnly && <span>Agent</span>}
      </button>
      <button className="lab-add-btn shell" onClick={onShell} title="new SSH shell">
        <IconTerminal />{!iconOnly && <span>Shell</span>}
      </button>
    </div>
  );
}
