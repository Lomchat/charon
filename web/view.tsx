import { mount, readSeed } from './mount';
// The viewers are styled by the page sheets, like `/`.
import '@/app/app.css';
import '@/app/density.css';
import StandaloneFileView from '@/app/StandaloneFileView';

// `/view?vps=&root=&path=` — one file, full window (server/http/pages.ts §
// viewPage): the file's rendered view, or why there is none.
type Seed = { refusal: string } | { vpsId: string; root: string; path: string };

const seed = readSeed<Seed>();
mount('refusal' in seed
  ? (
    <div className="sfv file-editor">
      <div className="dvm-note err">{seed.refusal}</div>
    </div>
  )
  : <StandaloneFileView vpsId={seed.vpsId} root={seed.root} path={seed.path} />);
