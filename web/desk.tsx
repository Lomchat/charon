import { mount, readSeed } from './mount';
// `app.css` too: the desk's modal mounts Charon's real session view.
import '@/app/app.css';
import '@/app/desk/desk.css';
import type { ComponentProps } from 'react';
import Desk from '@/app/desk/Desk';

// `/desk` — the machine room. Server data: server/http/pages.ts § deskPage.
mount(<Desk {...readSeed<ComponentProps<typeof Desk>>()} />);
