import { mount, readSeed } from './mount';
import '@/app/app.css';
import '@/app/density.css';
import type { ComponentProps } from 'react';
import HubPanel from '@/app/HubPanel';

// `/` — the hub. The server's first data: server/http/pages.ts § hubPage.
mount(<HubPanel {...readSeed<ComponentProps<typeof HubPanel>>()} />);
