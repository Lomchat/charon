'use client';
import '../claude.css';
import '../_designlab/lab.css';
import './v3.css';
import FolderTreeLab from '../_designlab/FolderTreeLab';

export default function V3() {
  return (
    <FolderTreeLab
      sepClass="sep-tree"
      variant="v3 · tree guides"
      blurb="Explorer-style hierarchy lines: a vertical guide ties each VPS's sessions back to its header, with a rule + spacing between VPSes. The structure reads as a tree."
    />
  );
}
