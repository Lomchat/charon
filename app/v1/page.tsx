'use client';
import '../claude.css';
import '../_designlab/lab.css';
import './v1.css';
import FolderTreeLab from '../_designlab/FolderTreeLab';

export default function V1() {
  return (
    <FolderTreeLab
      sepClass="sep-box"
      variant="v1 · boxed VPS"
      blurb="Each VPS is its own bordered panel inside the folder — clear boxes with breathing room between them, so you instantly see where one VPS ends and the next begins."
    />
  );
}
