'use client';
import { lazy, Suspense, type ComponentType, type ReactNode } from 'react';

// A component loaded on first render (its own chunk), with an optional
// placeholder meanwhile — the `next/dynamic` contract Charon relies on.
// `ssr` is accepted and ignored: nothing renders on the server any more.
// A failed chunk load throws to the nearest error boundary (§14.57).

type ComponentModule<P> = { default: ComponentType<P> };
type Loader<P> = () => Promise<ComponentType<P> | ComponentModule<P>>;
type Options = {
  ssr?: boolean;
  loading?: (props: { isLoading?: boolean; pastDelay?: boolean; error?: Error | null }) => ReactNode;
};

export default function dynamic<P = object>(loader: Loader<P>, options: Options = {}): ComponentType<P> {
  const Lazy = lazy(async () => {
    const m = await loader();
    return { default: ('default' in (m as object) ? (m as ComponentModule<P>).default : m) as ComponentType<P> };
  });
  const Loading = options.loading;
  function Dynamic(props: P) {
    return (
      <Suspense fallback={Loading ? <Loading isLoading pastDelay error={null} /> : null}>
        {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
        <Lazy {...(props as any)} />
      </Suspense>
    );
  }
  return Dynamic;
}
