'use client';
import '../claude.css';
import '../_designlab/lab.css';
import './v2.css';
import FolderTreeLab from '../_designlab/FolderTreeLab';

export default function V2() {
  return (
    <FolderTreeLab
      sepClass="sep-band"
      variant="v2 · header band"
      blurb="Each VPS opens with a filled header band (a little sub-title bar with an accent edge), and VPSes are spaced apart — the band alone tells you where each VPS starts."
    />
  );
}
